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
            parts.push('\n### 등급별 PF금리 — 선/중/후순위 시뮬레이션 결과');
            parts.push('| 등급 | 현행(전체) | 시뮬후(전체) | Δ | 선순위(현) | 선순위(후) | 중순위(현) | 중순위(후) | 후순위(현) | 후순위(후) | LTV | DSCR |');
            parts.push('|------|-----------|------------|---|----------|----------|----------|----------|----------|----------|-----|------|');
            simState.pfImpacts.forEach(p => {
                const d = p.delta >= 0 ? '+' : '';
                parts.push(`| ${p.grade} | ${p.currentRate}% | ${p.newRate}% | ${d}${p.delta}%p | ${p.seniorCurrent??'-'}% | ${p.seniorNew??'-'}% | ${p.mezzCurrent??'-'}% | ${p.mezzNew??'-'}% | ${p.juniorCurrent??'-'}% | ${p.juniorNew??'-'}% | ${p.ltv??'-'} | ${p.dscr??'-'} |`);
            });
        }
    }

    return parts.join('\n');
}

const SYSTEM_PROMPT = `당신은 Goldman Sachs 글로벌 인베스트먼트 리서치 출신 한국 건설·부동산 수석 애널리스트입니다.
제공된 실시간 시장 데이터와 계량경제 시뮬레이션 결과를 바탕으로, CIO·CFO가 즉시 의사결정에 활용할 수 있는 기밀 수준의 고밀도 분석 리포트를 작성합니다.

**절대 금지**: HTML 태그 사용. 순수 마크다운(파이프 테이블 포함)만 허용.
**테이블 형식**: | 컬럼1 | 컬럼2 | 형식 엄수. 구분선(|---|---|) 필수.

---

# ◆ EXECUTIVE SUMMARY

2~3문장으로 압축. 형식: [시나리오 요약] → [12M 핵심 전망 수치] → [최대 리스크] → [즉시 권고].
수치 없는 요약은 무효. 반드시 % 수치와 등급을 명시.

---

## SECTION A — 오늘 꼭 알아야 할 사항 (Today's Critical Alerts)

실시간 시장 데이터에서 오늘 현재 가장 중요한 경보 3~5개를 추출하여 서술.
형식: **[ALERT]** 또는 **[WATCH]** 또는 **[INFO]** 레이블로 심각도 구분.
- 각 항목: 지표명 + 현재값 + 임계치 대비 포지션 + 건설업 영향 직접 서술
- 데이터가 있는 지표만 서술. 없으면 항목 생략.
- 예시: **[ALERT]** USD/KRW 1,485원 — 2022년 고점(1,445원) 돌파. 수입 철강·알루미늄 단가 즉시 압박.

---

## SECTION B — 거시경제 현황 진단

현재 매크로 환경을 구조적으로 분석. 제공된 수치를 직접 인용하여 작성.

### B-1. 금리 및 유동성 환경
Fed 기준금리, 한국 기준금리, 금리차, 시장 금리(US10Y) 현황. 방향성과 건설 조달비용 영향.

### B-2. 원자재 및 환율
WTI/Brent 현재가·방향성, USD/KRW 수준, 철근·구리 동향. 원가 압박 강도를 "약함/중간/강함/긴급" 4단계로 평가.

### B-3. 건설업 특화 지표
건설공사비지수(CCI) 현재 수준, 최근 MoM 추세(제공된 6개월 데이터 인용), 건설주 동향.

**Key Figure**: CCI [값] | 최근 MoM 평균 [값]% | 원가압박 수준: [단계]

---

## SECTION C — 시뮬레이션 시나리오 분석

### C-1. 충격 전파 경로 (Attribution 기반)
제공된 Attribution 데이터에서 기여도 상위 변수 중심으로 4개 경로를 체인 형식으로 서술.
형식: **경로명** (기여도 X%): [충격] → [중간매개, lag Xm] → [건설비 영향 +X%]

Attribution 데이터가 없으면 이 섹션을 "(Attribution 데이터 미제공 — 경로 분석 생략)" 으로 처리.

### C-2. 3M/6M/12M 전망

| 기간 | 공사비 누적 변동 | 신뢰구간 | 핵심 드라이버 |
|------|---------------|---------|-------------|
| 3개월 | | | |
| 6개월 | | | |
| 12개월 | | | |

낙관/기본/비관 3개 밴드를 서술하되, 기본 시나리오 수치를 테이블에 기입.

### C-3. 모델 신뢰도
R², N/K 비율, 방법론 수렴도를 1~2줄로 요약. **신뢰도: HIGH / MODERATE / LOW** 명시.

---

## SECTION D — 부동산 유형별 원가 영향

**중요**: 유형명은 제공된 데이터의 원래 명칭을 그대로 사용. 절대 변경·대체 금지. (아파트/오피스텔/상가/오피스/지식산업센터/물류센터)

6개 유형 비교 테이블 (반드시 아래 형식 준수):

| 유형 | 기준단가(만원/평) | 재료비% | 노무비% | 12M 영향(%) | 평당 증가(만원) | 리스크 등급 |
|------|----------------|--------|--------|-----------|--------------|-----------|

- 평당 증가(만원) = 기준단가 × 12M 영향% / 100 으로 계산
- 리스크 등급: 상/중상/중/중하/하 5단계
- 아래에 핵심 해석 2~3줄: 가장 취약한 유형, 방어적 유형, 실무 시사점.

---

## SECTION E — PF금리 및 금융시장 영향

### E-1. 등급×트랜치별 금리 시뮬레이션

제공된 선순위/중순위/후순위 데이터를 모두 사용하여 아래 테이블을 완성:

| 등급 | 선순위(현) | 선순위(후) | 중순위(현) | 중순위(후) | 후순위(현) | 후순위(후) | 전체Δ |
|------|----------|----------|----------|----------|----------|----------|------|

### E-2. 금융시장 연계 분석
- 한국 PF 시장 현황: 브릿지론 만기 리스크, 미분양 재고 연계
- BBB0 이하 고위험 프로젝트: 후순위 금리 수준과 사업성 훼손 임계치
- **Key Figure**: BBB0 후순위 시뮬레이션 후 금리 [X]% — 일반 분양가 내 원가 흡수 가능 여부

---

## SECTION F — 핵심 리스크 레지스터 (Top 3)

각 리스크를 아래 형식으로 서술:

**[RISK 1] [리스크명]** | 발현확률: 상/중/하 | 영향도: 상/중/하
- 메커니즘: (1~2줄)
- 선행지표: [구체 지표명] | 트리거: [수치 임계치]
- 건설비/PF 즉시 영향: [정량]

---

## SECTION G — 이해관계자 전략 매트릭스

| 주체 | 즉시 조치 (0~3M) | 중기 전략 (3~12M) | 위험 임계치 |
|------|----------------|-----------------|-----------|
| 건설사 | | | |
| 시행사/디벨로퍼 | | | |
| 금융기관(PF) | | | |
| 발주자(공공) | | | |

---

## 작성 원칙
- **순수 마크다운만 사용. HTML 태그(table, div, tr, td 등) 절대 금지.**
- 테이블은 파이프(|) 형식만 사용. 구분선(|---|---|) 필수.
- 모든 수치는 제공 데이터에서 직접 인용. 추정치는 "(추정)" 명기.
- 데이터 없는 지표는 "N/A" 또는 항목 생략 — 수치 창작 금지.
- 분량: 섹션당 최소 150자. 총 5000~8000자.
- 톤: 정밀·간결·행동지향. 수사적 표현 배제.
- 단위: 만원/평, 억원, %p, bp 한국 실무 단위.
- 숫자 정밀도: % 값은 소수점 1자리. 금리는 소수점 2자리.`;

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
            model: 'kimi-latest',
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
