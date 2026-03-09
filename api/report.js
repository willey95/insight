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
        const s = simState.shocks || {};
        parts.push('\n## 시뮬레이션 시나리오');
        parts.push(`- 분석기간: ${simState.periodLabel || '전체 63개월'} | 방법론: ${simState.methodLabel || 'All (3방법 비교)'}`);
        parts.push(`- 충격 설정: 환율 ${s.fx >= 0 ? '+' : ''}${s.fx}%, 유가 ${s.oil >= 0 ? '+' : ''}${s.oil}%, PPI ${s.ppi >= 0 ? '+' : ''}${s.ppi}%, 노무비 ${s.labor >= 0 ? '+' : ''}${s.labor}%, 금리 ${s.policyRate >= 0 ? '+' : ''}${s.policyRate}%p`);

        if (simState.latest) {
            const l = simState.latest;
            parts.push(`\n### 기준 데이터 (${l.month})`);
            parts.push(`| 지표 | 현재값 |`);
            parts.push(`|------|--------|`);
            parts.push(`| 건설공사비지수 | ${l.cci} |`);
            parts.push(`| USD/KRW | ${l.fx} |`);
            parts.push(`| WTI | $${l.oil}/bbl |`);
            parts.push(`| 생산자물가(PPI) | ${l.ppi} |`);
            parts.push(`| 건설노임지수 | ${l.labor} |`);
            parts.push(`| 기준금리 | ${l.policyRate}% |`);
        }

        if (simState.trend && simState.trend.length > 0) {
            parts.push('\n### 최근 6개월 추세');
            parts.push('| 월 | 공사비지수 | 환율 | 유가 | MoM변화 |');
            parts.push('|---|---|---|---|---|');
            simState.trend.forEach(r => {
                parts.push(`| ${r.month} | ${r.cci} | ${r.fx} | ${r.oil} | ${r.costMoM != null ? (r.costMoM >= 0 ? '+' : '') + r.costMoM.toFixed(2) + '%' : '-'} |`);
            });
        }

        if (simState.forecast) {
            const f = simState.forecast;
            parts.push('\n### 시뮬레이션 전망');
            parts.push(`| 기간 | 건설공사비 누적 변동 |`);
            parts.push(`|------|---------------------|`);
            if (f.m3 != null)  parts.push(`| 3개월 | ${f.m3 >= 0 ? '+' : ''}${f.m3.toFixed(2)}% |`);
            if (f.m6 != null)  parts.push(`| 6개월 | ${f.m6 >= 0 ? '+' : ''}${f.m6.toFixed(2)}% |`);
            if (f.m12 != null) parts.push(`| 12개월 | ${f.m12 >= 0 ? '+' : ''}${f.m12.toFixed(2)}% |`);
        }

        if (simState.attribution && simState.attribution.length > 0) {
            parts.push('\n### 변수별 기여도 분석 (Attribution)');
            parts.push('| 변수 | 기여도(%) | 반영시차(M) | 전달경로 |');
            parts.push('|------|----------|------------|---------|');
            simState.attribution.forEach(a => {
                parts.push(`| ${a.label || a.key} | ${a.contribution >= 0 ? '+' : ''}${(a.contribution || 0).toFixed(1)}% | ${a.peakLag || '-'} | ${a.route || '-'} |`);
            });
        }

        if (simState.modelStats) {
            const ms = simState.modelStats;
            parts.push('\n### 모델 검증 지표');
            parts.push(`| 항목 | 값 |`);
            parts.push(`|------|-----|`);
            if (ms.gaussianR2 != null) parts.push(`| Gaussian IRF R² | ${ms.gaussianR2.toFixed(3)} |`);
            if (ms.ardlR2 != null)     parts.push(`| ARDL-OLS R² (6M) | ${ms.ardlR2.toFixed(3)} |`);
            if (ms.lpR2 != null)       parts.push(`| Local Projections R² (6M) | ${ms.lpR2.toFixed(3)} |`);
            if (ms.nObs != null)       parts.push(`| 표본 수 (N) | ${ms.nObs} |`);
            if (ms.kParams != null)    parts.push(`| 계수 수 (K) | ${ms.kParams} |`);
            if (ms.nObs && ms.kParams) parts.push(`| N/K 비율 | ${(ms.nObs / ms.kParams).toFixed(1)} |`);
            if (ms.sampleWarning)      parts.push(`| 표본 경고 | ${ms.sampleWarning} |`);
            if (ms.methodConvergence)  parts.push(`| 방법론 수렴도 | ${ms.methodConvergence} |`);
        }

        if (simState.pyeongImpacts && simState.pyeongImpacts.length > 0) {
            parts.push('\n### 유형별 건축공사비 영향 (12M 시뮬레이션)');
            parts.push('| 유형 | 기준단가(만원/평) | 재료비% | 노무비% | 12M 영향 |');
            parts.push('|------|----------------|--------|--------|---------|');
            simState.pyeongImpacts.forEach(p => {
                parts.push(`| ${p.type} | ${p.baseline} | ${p.materialPct}% | ${p.laborPct}% | ${p.impact12 >= 0 ? '+' : ''}${p.impact12}% |`);
            });
        }

        if (simState.pfImpacts && simState.pfImpacts.length > 0) {
            parts.push('\n### 등급별 PF금리 변동');
            parts.push('| 등급 | 현행금리 | 시뮬레이션 후 | 변동 |');
            parts.push('|------|---------|--------------|-----|');
            simState.pfImpacts.forEach(p => {
                parts.push(`| ${p.grade} | ${p.currentRate}% | ${p.newRate}% | ${p.delta >= 0 ? '+' : ''}${p.delta}%p |`);
            });
        }
    }

    return parts.join('\n');
}

const SYSTEM_PROMPT = `당신은 한국 건설·부동산 시장 전문 수석 애널리스트입니다.
McKinsey, Goldman Sachs 리서치 부문 수준의 고밀도 분석 리포트를 작성합니다.
주어진 실시간 시장 데이터, 계량경제 시뮬레이션 결과, 모델 검증 지표를 종합하여 의사결정자 수준의 인사이트를 제공합니다.

## 리포트 구조 (반드시 아래 섹션 순서로 작성)

# EXECUTIVE SUMMARY
3-4문장. 핵심 메시지만. "현재 상황 → 시뮬레이션이 시사하는 것 → 가장 큰 리스크 → 권고 행동" 구조.
예: "유가 +20% 시나리오 하 12개월 공사비 +X.X% 전망 (Gaussian/ARDL/LP 3방법 수렴). 핵심 기여 변수는 [변수명] (기여도 X%). BBB등급 PF금리 +X.Xbp 상승 위험. 단기 헤징 및 원자재 조달 전략 선제 검토 권고."

---

## 0. 데이터 신뢰도 및 모델 검증
제공된 모델 검증 지표를 기반으로 결과의 신뢰도를 먼저 평가.
- R² 값과 그 의미 해석
- N/K 비율과 과적합 위험 평가
- 방법론별 수렴도 (3방법 결과가 유사한지 상이한지)
- **결론: 본 리포트의 결과 신뢰도를 HIGH / MODERATE / LOW 로 명시**

## 1. 현재 시장 환경 진단
현재 매크로 지표를 구조적으로 분석. 최근 6개월 추세가 있으면 반드시 활용.
- 각 핵심 드라이버의 현재 수준과 방향성 (상승/하락/횡보)
- 전월 대비, 전년 동기 대비 변화폭을 구체적 수치로 서술
- 건설업에 특히 중요한 변수 강조 (환율, 유가, 철근, 노무비, 금리)
- **Key Figure: 현재 기준 건설공사비지수 및 전년 대비 변동률**

## 2. 시나리오 충격 전파 경로 분석
설정된 충격 시나리오가 건설공사비에 도달하는 경로를 최소 4개 chain으로 서술.
각 chain마다 시차(lag), 전가율(pass-through)을 Attribution 데이터에서 인용.

형식 예시:
- **경로 1**: 유가 +20% → 운송비·연료비 상승 (2M lag) → 레미콘·아스팔트 가격 +X% → 재료비 +Y% → 공사비지수 +Z%
- **경로 2**: 환율 +10% → 수입 철강·알루미늄 단가 +X% (1M lag) → 구조재 비용 상승 → 공사비지수 +Y%
- **경로 3**: PPI +3% → 전 자재 동반 상승 → 재료비 직접 영향 +X%
- **경로 4**: 금리 +1%p → 조달비용 상승 → 입찰가 상향 압력 + 프로젝트 지연 리스크

## 3. 시뮬레이션 결과 해석
3M / 6M / 12M 전망을 Attribution 및 방법론별 수렴도를 함께 서술.
- 수치 직인용 필수
- 최대 기여 변수와 기여도(%) 명시
- 방법론 간 결과 편차가 크면 불확실성 구간으로 제시
- 낙관(충격 축소 시) / 기본(현 설정) / 비관(충격 확대 시) 3개 시나리오 밴드

## 4. 부동산 유형별 차등 영향
6개 유형(아파트, 오피스텔, 상가, 오피스, 지식산업센터, 물류센터)에 대한 시뮬레이션 결과 비교.
반드시 테이블 포함:

| 유형 | 기준단가(만원/평) | 재료비% | 노무비% | 12M 영향(%) | 민감도 특성 |
|------|----------------|--------|--------|------------|-----------|

- 재료비·노무비 비중 차이에 따른 민감도 차이 정성 해석
- 가장 취약한 유형과 상대적으로 방어적인 유형 명시

## 5. PF금리 및 금융시장 연계 영향
기준금리 변화 + 건설공사비 상승이 PF금리에 미치는 복합 효과.
반드시 테이블 포함:

| 등급 | 현행금리 | 시뮬레이션 후 | 변동 | 선순위 | 중순위 | 후순위 |
|------|---------|--------------|-----|-------|-------|-------|

- 현재 한국 PF 시장 맥락 (미분양 리스크, 브릿지론 만기 등) 연계 분석
- BBB등급 이하 고위험 프로젝트에 대한 특별 경고

## 6. 핵심 리스크 Top 3 및 선행지표
심각도 순으로 3개 리스크를 명시.
각 리스크:
- 리스크 내용과 메커니즘
- 선행지표 (모니터링해야 할 구체 지표)
- 트리거 포인트 (이 수준을 넘으면 경고)
- 발현 가능성 / 영향도 평가

## 7. 이해관계자별 전략적 시사점
4개 그룹에 대해 각 2-3개의 구체적 액션 아이템:
- **건설사**: 원가 헤징, 계약 구조 조정 등
- **디벨로퍼/시행사**: 사업성 재검토 기준, 분양가 반영 등
- **금융기관**: 담보 인정비율 조정, 스트레스 테스트 기준
- **발주자(공공/민간)**: 예산 조정 시나리오, 발주 시점 전략

---

## 작성 규칙
- 한국어 작성. 전문 용어는 영문 병기 허용.
- **모든 수치는 제공된 데이터에서 직접 인용** — 추정이면 "(추정)" 명기
- 데이터에 없는 수치를 창작하지 말 것 — 불확실하면 범위로 표현
- 마크다운 형식 사용 (# ## ### | - 1. ** 등)
- 분량: 4000-7000 토큰. 각 섹션 최소 200자 이상.
- 톤: 권위적·정밀한 전문가 톤. 불필요한 수사 배제. 숫자가 핵심.
- 금액: 만원/평, 억원, 조원 등 한국 건설업 실무 단위
- 금리: %p 단위 명시 (bp로도 병기 가능)
- 전파경로: "변수(충격) → 중간경로(시차) → 최종영향(정량)" 화살표 체인
- 비교 데이터는 반드시 테이블로
- 각 섹션 끝 **Key Figure** 볼드 강조
- 섹션 0의 신뢰도 평가가 MODERATE 이하이면, 전 섹션에 걸쳐 수치 해석 시 한계를 병기`;

const USER_MSG = (context) => `다음 실시간 시장 데이터와 시뮬레이션 결과를 기반으로 건설공사비 영향 분석 리포트를 작성해주세요.\n\n${context}`;

async function callLLM(context) {
    const providers = [];
    // Moonshot (primary) → Claude (fallback) → GPT-4o (fallback)
    if (MOONSHOT_API_KEY) providers.push({ fn: callMoonshot, name: 'Moonshot Kimi' });
    if (ANTHROPIC_API_KEY) providers.push({ fn: callAnthropic, name: 'Claude' });
    if (OPENAI_API_KEY) providers.push({ fn: callOpenAI, name: 'GPT-4o' });
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
            model: 'moonshot-v1-latest',
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_MSG(context) }],
            max_tokens: 8000, temperature: 0.3
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
            model: 'gpt-4o',  // upgraded from gpt-4o-mini for analyst-grade output
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_MSG(context) }],
            max_tokens: 8000, temperature: 0.3
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
            model: 'claude-opus-4-6',  // upgraded for analyst-grade depth
            max_tokens: 8000,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: USER_MSG(context) }]
        })
    });
    if (!response.ok) throw new Error(`Anthropic ${response.status}: ${await response.text()}`);
    const data = await response.json();
    return data.content?.[0]?.text || 'Report generation failed';
}
