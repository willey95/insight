const { buildIndicatorsPayload, buildCorrelationPayload } = require('./_lib/shared');

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
        // Parse simulation state from POST body
        let simState = null;
        if (req.method === 'POST' && req.body) {
            simState = req.body.simState || null;
        }

        const [indicators, correlation] = await Promise.all([
            buildIndicatorsPayload().catch(() => null),
            buildCorrelationPayload().catch(() => null)
        ]);

        const context = buildReportContext(indicators, correlation, simState);
        const { text, model } = await callLLM(context);

        res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=120');
        res.status(200).json({
            report: text,
            model,
            generatedAt: new Date().toISOString(),
            dataTimestamp: indicators?.timestamp || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message || 'report generation failed' });
    }
};

function buildReportContext(indicators, correlation, simState) {
    const parts = [];

    if (indicators) {
        parts.push('## 현재 시장 데이터 (실시간)');

        if (indicators.fedfunds != null) parts.push(`- Fed 기준금리: ${indicators.fedfunds}%`);
        if (indicators.bok != null) parts.push(`- 한국 기준금리: ${indicators.bok}%`);
        if (indicators.usdkrw != null) parts.push(`- USD/KRW: ${indicators.usdkrw} (${indicators.usdkrwChangePct >= 0 ? '+' : ''}${indicators.usdkrwChangePct}%)`);

        if (indicators.commodities) {
            const c = indicators.commodities;
            parts.push('\n### 원자재');
            if (c.wti) parts.push(`- WTI: $${c.wti.value} (${c.wti.changePct >= 0 ? '+' : ''}${c.wti.changePct}%)`);
            if (c.brent) parts.push(`- Brent: $${c.brent.value} (${c.brent.changePct >= 0 ? '+' : ''}${c.brent.changePct}%)`);
            if (c.steel) parts.push(`- 철근: $${c.steel.value}/t (${c.steel.changePct >= 0 ? '+' : ''}${c.steel.changePct}%)`);
            if (c.copper) parts.push(`- 구리: $${c.copper.value}/lb (${c.copper.changePct >= 0 ? '+' : ''}${c.copper.changePct}%)`);
        }

        if (indicators.macroIndicators) {
            const m = indicators.macroIndicators;
            parts.push('\n### 거시지표');
            if (m.vix) parts.push(`- VIX: ${m.vix.value} (${m.vix.changePct >= 0 ? '+' : ''}${m.vix.changePct}%)`);
            if (m.us10y) parts.push(`- US 10Y: ${m.us10y.value}% (${m.us10y.changePct >= 0 ? '+' : ''}${m.us10y.changePct}%)`);
        }

        if (indicators.sectorStocks) {
            const s = indicators.sectorStocks;
            const keys = ['hyundaie', 'daewooec', 'dlenc', 'gsenc', 'poscoenc'];
            const names = { hyundaie: '현대건설', daewooec: '대우건설', dlenc: 'DL이앤씨', gsenc: 'GS건설', poscoenc: '포스코이앤씨' };
            parts.push('\n### 건설주');
            keys.forEach(k => {
                if (s[k]) parts.push(`- ${names[k]}: ${s[k].value?.toLocaleString()}원 (${s[k].changePct >= 0 ? '+' : ''}${s[k].changePct}%)`);
            });
            if (s.constructionAvg) parts.push(`- **건설주 평균**: ${s.constructionAvg.value?.toLocaleString()}원 (${s.constructionAvg.changePct >= 0 ? '+' : ''}${s.constructionAvg.changePct}%)`);
        }
    }

    if (correlation) {
        parts.push('\n## 5Y 상관관계 요약');
        const labels = correlation.labels || [];
        const matrix = correlation.matrix || [];
        parts.push(`분석기간: ${correlation.months?.[0]} ~ ${correlation.months?.[correlation.months.length - 1]} (${correlation.dataPoints}개월)`);
        matrix.forEach((row, i) => {
            const cells = row.map((v, j) => v != null ? v.toFixed(2) : '---');
            parts.push(`${labels[i]}: [${cells.join(', ')}]`);
        });
    }

    if (simState) {
        parts.push('\n## 시뮬레이션 시나리오 (사용자 설정)');
        if (simState.shocks) {
            const s = simState.shocks;
            parts.push(`- 환율 충격: ${s.fx >= 0 ? '+' : ''}${s.fx}%`);
            parts.push(`- 유가 충격: ${s.oil >= 0 ? '+' : ''}${s.oil}%`);
            parts.push(`- PPI 충격: ${s.ppi >= 0 ? '+' : ''}${s.ppi}%`);
            parts.push(`- 노무비 충격: ${s.labor >= 0 ? '+' : ''}${s.labor}%`);
            parts.push(`- 금리 변화: ${s.policyRate >= 0 ? '+' : ''}${s.policyRate}%p`);
        }
        if (simState.latest) {
            const l = simState.latest;
            parts.push(`\n최신 데이터 (${l.month}): 건설공사비지수=${l.cci}, 환율=${l.fx}, 유가=${l.oil}, PPI=${l.ppi}, 노무비=${l.labor}, 기준금리=${l.policyRate}%`);
        }
        if (simState.forecast) {
            const f = simState.forecast;
            parts.push(`\n시뮬레이션 결과:`);
            if (f.m3 != null) parts.push(`- 3개월 전망: ${f.m3 >= 0 ? '+' : ''}${f.m3.toFixed(2)}%`);
            if (f.m6 != null) parts.push(`- 6개월 전망: ${f.m6 >= 0 ? '+' : ''}${f.m6.toFixed(2)}%`);
            if (f.m12 != null) parts.push(`- 12개월 전망: ${f.m12 >= 0 ? '+' : ''}${f.m12.toFixed(2)}%`);
        }
    }

    return parts.join('\n');
}

const SYSTEM_PROMPT = `당신은 McKinsey, BCG급 전략 컨설팅 펌의 건설·부동산 시장 수석 애널리스트입니다.
주어진 실시간 시장 데이터와 시뮬레이션 결과를 분석하여, 전문 투자자 및 의사결정자를 위한 고밀도 분석 리포트를 작성합니다.

## 리포트 구조 (반드시 아래 섹션 순서로 작성)

# EXECUTIVE SUMMARY
2-3문장으로 현 시장 상황의 핵심 메시지 전달. "So what?"에 답하는 형태.

## 1. 시장 환경 진단
현재 매크로 환경을 구조적으로 분석. 환율, 유가, 금리, 원자재 등 핵심 드라이버별 현황과 방향성.
수치를 반드시 인용하고, 전월 대비 변화 방향 포함.

## 2. 건설공사비 영향 경로 분석
각 매크로 변수가 건설공사비에 미치는 전파 경로를 구체적으로 서술.
예: "유가 +20% → 아스팔트·레미콘 운송비 상승 → 재료비 +X% → 공사비지수 +Y%"
가능하면 3개 이상의 전파 경로를 분석.

## 3. 시나리오별 전망
시뮬레이션 데이터가 있으면 이를 기반으로 3M/6M/12M 전망 제시.
없으면 현재 추세 기반으로 전망. 낙관/기본/비관 시나리오로 구분.

### 단기 (3개월)
### 중기 (6개월)
### 장기 (12개월)

## 4. 부동산 유형별 차등 영향
아파트, 오피스텔, 상가, 오피스, 지식산업센터, 물류센터 각각에 대한 차등 영향 분석.
재료비/노무비 비중 차이에 따른 민감도 차이를 설명.

## 5. PF금리 및 금융시장 연계 분석
기준금리 변화와 건설공사비 상승이 PF금리에 미치는 복합 효과.
등급별(AA~BBB) 스프레드 변화 전망.

## 6. 핵심 리스크 및 모니터링 포인트
상위 3개 리스크를 심각도 순으로 나열.
각 리스크별 선행지표와 트리거 포인트 명시.

## 7. 전략적 시사점
건설사, 디벨로퍼, 금융기관, 발주자 각 이해관계자별 액션 아이템 제시.

---
작성 규칙:
- 한국어로 작성, 전문 용어는 영문 병기 가능
- 모든 수치는 데이터에서 직접 인용 (추정 시 "추정" 명기)
- 마크다운 형식 (# ## ### - 1. ** 등) 사용
- 분량: 충분히 상세하게 (2000-3500 토큰)
- 톤: 권위적이고 정밀한 전문가 톤. 불필요한 수사 배제.
- 숫자가 핵심. 정성적 표현만의 문장은 지양.`;

const USER_MSG = (context) => `다음 실시간 시장 데이터와 시뮬레이션 결과를 기반으로 건설공사비 영향 분석 리포트를 작성해주세요.\n\n${context}`;

async function callLLM(context) {
    const providers = [];
    if (ANTHROPIC_API_KEY) providers.push({ fn: callAnthropic, name: 'Claude' });
    if (OPENAI_API_KEY) providers.push({ fn: callOpenAI, name: 'GPT-4o' });
    if (MOONSHOT_API_KEY) providers.push({ fn: callMoonshot, name: 'Moonshot' });
    for (const { fn, name } of providers) {
        try {
            const text = await fn(context);
            return { text, model: name };
        }
        catch (e) { console.error(`LLM fallback (${name}): ${e.message}`); }
    }
    throw new Error('All LLM providers failed');
}

async function callMoonshot(context) {
    const response = await fetch('https://api.moonshot.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MOONSHOT_API_KEY}` },
        body: JSON.stringify({
            model: 'moonshot-v1-32k',
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_MSG(context) }],
            max_tokens: 4000, temperature: 0.5
        })
    });
    if (!response.ok) throw new Error(`Moonshot ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'Report generation failed';
}

async function callOpenAI(context) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_MSG(context) }],
            max_tokens: 4000, temperature: 0.5
        })
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || 'Report generation failed';
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
            max_tokens: 4000,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: USER_MSG(context) }]
        })
    });
    if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.content?.[0]?.text || 'Report generation failed';
}
