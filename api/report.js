const { buildIndicatorsPayload, buildCorrelationPayload } = require('./_lib/shared');

// LLM Provider (priority: Moonshot → OpenAI → Anthropic)
const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (!MOONSHOT_API_KEY && !OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
        res.status(503).json({ error: 'No LLM API key configured (MOONSHOT / OPENAI / ANTHROPIC)' });
        return;
    }

    try {
        // Gather current data
        const [indicators, correlation] = await Promise.all([
            buildIndicatorsPayload().catch(() => null),
            buildCorrelationPayload().catch(() => null)
        ]);

        // Build context for LLM
        const context = buildReportContext(indicators, correlation);

        // Call LLM API (priority: Moonshot → OpenAI → Anthropic)
        const report = await callLLM(context);

        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=120');
        res.status(200).json({
            report,
            generatedAt: new Date().toISOString(),
            dataTimestamp: indicators?.timestamp || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message || 'report generation failed' });
    }
};

function buildReportContext(indicators, correlation) {
    const parts = [];

    if (indicators) {
        parts.push('## 현재 시장 데이터');

        if (indicators.fedfunds != null) parts.push(`- Fed 기준금리: ${indicators.fedfunds}%`);
        if (indicators.bok != null) parts.push(`- 한국 기준금리: ${indicators.bok}%`);
        if (indicators.usdkrw != null) parts.push(`- USD/KRW: ${indicators.usdkrw} (${indicators.usdkrwChangePct >= 0 ? '+' : ''}${indicators.usdkrwChangePct}%)`);

        if (indicators.commodities) {
            const c = indicators.commodities;
            if (c.wti) parts.push(`- WTI: $${c.wti.value} (${c.wti.changePct >= 0 ? '+' : ''}${c.wti.changePct}%)`);
            if (c.brent) parts.push(`- Brent: $${c.brent.value} (${c.brent.changePct >= 0 ? '+' : ''}${c.brent.changePct}%)`);
            if (c.steel) parts.push(`- 철근: $${c.steel.value}/t (${c.steel.changePct >= 0 ? '+' : ''}${c.steel.changePct}%)`);
        }

        if (indicators.macroIndicators) {
            const m = indicators.macroIndicators;
            if (m.vix) parts.push(`- VIX: ${m.vix.value} (${m.vix.changePct >= 0 ? '+' : ''}${m.vix.changePct}%)`);
            if (m.us10y) parts.push(`- US 10Y: ${m.us10y.value}% (${m.us10y.changePct >= 0 ? '+' : ''}${m.us10y.changePct}%)`);
        }

        if (indicators.sectorStocks) {
            const s = indicators.sectorStocks;
            const constKeys = ['hyundaie', 'daewooec', 'dlenc', 'gsenc', 'poscoenc'];
            const names = { hyundaie: '현대건설', daewooec: '대우건설', dlenc: 'DL이앤씨', gsenc: 'GS건설', poscoenc: '포스코이앤씨' };
            parts.push('\n### 건설주');
            constKeys.forEach(k => {
                if (s[k]) parts.push(`- ${names[k]}: ₩${s[k].value?.toLocaleString()} (${s[k].changePct >= 0 ? '+' : ''}${s[k].changePct}%)`);
            });
            if (s.constructionAvg) parts.push(`- **건설주 평균**: ₩${s.constructionAvg.value?.toLocaleString()} (${s.constructionAvg.changePct >= 0 ? '+' : ''}${s.constructionAvg.changePct}%)`);
        }
    }

    if (correlation) {
        parts.push('\n## 5Y 상관관계 매트릭스');
        const labels = correlation.labels || [];
        const matrix = correlation.matrix || [];
        parts.push(`기간: ${correlation.months?.[0]} ~ ${correlation.months?.[correlation.months.length - 1]} (${correlation.dataPoints}개월)`);
        matrix.forEach((row, i) => {
            const cells = row.map((v, j) => v != null ? v.toFixed(2) : '---');
            parts.push(`${labels[i]}: [${cells.join(', ')}]`);
        });
    }

    return parts.join('\n');
}

const SYSTEM_PROMPT = `당신은 건설·부동산 시장 전문 애널리스트입니다. 주어진 실시간 시장 데이터를 분석하여 건설공사비 영향 관점의 리포트를 작성합니다.

리포트 구조:
1. **시장 요약** (현재 상황 2-3문장)
2. **핵심 리스크 요인** (상위 3개, 각각 원인→경로→영향 형식)
3. **건설공사비 전망** (단기 3M / 중기 6M / 장기 12M)
4. **투자 시사점** (건설사, 디벨로퍼, 발주자 각 관점)
5. **모니터링 포인트** (향후 주시할 지표 3개)

한국어로 작성하고, 데이터 기반으로 구체적 수치를 인용하세요. 마크다운 형식으로 작성하세요.`;

const USER_MSG = (context) => `다음 실시간 시장 데이터를 분석하여 건설공사비 영향 리포트를 작성해주세요.\n\n${context}`;

async function callLLM(context) {
    const providers = [];
    if (MOONSHOT_API_KEY) providers.push(callMoonshot);
    if (OPENAI_API_KEY) providers.push(callOpenAI);
    if (ANTHROPIC_API_KEY) providers.push(callAnthropic);
    for (const fn of providers) {
        try { return await fn(context); }
        catch (e) { console.error(`LLM fallback: ${e.message}`); }
    }
    throw new Error('All LLM providers failed');
}

async function callMoonshot(context) {
    const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${MOONSHOT_API_KEY}`
        },
        body: JSON.stringify({
            model: 'moonshot-v1-8k',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: USER_MSG(context) }
            ],
            max_tokens: 2000,
            temperature: 0.7
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Moonshot API error: ${response.status} — ${err}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '리포트 생성 실패';
}

async function callOpenAI(context) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: USER_MSG(context) }
            ],
            max_tokens: 2000,
            temperature: 0.7
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`OpenAI API error: ${response.status} — ${err}`);
    }
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '리포트 생성 실패';
}

async function callAnthropic(context) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 2000,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: USER_MSG(context) }]
        })
    });
    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic API error: ${response.status} — ${err}`);
    }
    const data = await response.json();
    return data.content?.[0]?.text || '리포트 생성 실패';
}
