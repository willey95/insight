# Crisis Monitoring Dashboard — Indicator Dynamics & Vector Propagation Algorithm

> **Version**: 2.0 (2026-03-08)
> **Engine**: Macro Construction Cost Simulation Engine v2
> **Methods**: Gaussian IRF / ARDL-OLS / Local Projections (Jordà 2005)
> **Data**: 60-month synthetic time series + real-time API (Yahoo Finance, FRED, ECOS)

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Indicator Taxonomy](#2-indicator-taxonomy)
3. [Network Topology — DAG](#3-network-topology--dag)
4. [Adjacency Matrix W](#4-adjacency-matrix-w)
5. [Pass-Through Vector P](#5-pass-through-vector-p)
6. [Shock Derivation (DAG Traversal)](#6-shock-derivation-dag-traversal)
7. [Method A: Gaussian IRF](#7-method-a-gaussian-irf)
8. [Method B: ARDL-OLS](#8-method-b-ardl-ols)
9. [Method C: Local Projections](#9-method-c-local-projections)
10. [Ensemble Forecast](#10-ensemble-forecast)
11. [Multi-Hop Path Decomposition](#11-multi-hop-path-decomposition)
12. [Correlation Dynamics (7×7 Matrix)](#12-correlation-dynamics-77-matrix)
13. [Sensitivity Analysis](#13-sensitivity-analysis)
14. [Monte Carlo Simulation](#14-monte-carlo-simulation)
15. [PF Grade Impact Model](#15-pf-grade-impact-model)
16. [Pressure State Machine](#16-pressure-state-machine)
17. [Attribution Engine](#17-attribution-engine)
18. [Analysis Periods](#18-analysis-periods)
19. [Full Pipeline Flowchart](#19-full-pipeline-flowchart)
20. [Implementation Reference](#20-implementation-reference)

---

## 1. System Overview

```
╔═══════════════════════════════════════════════════════════════════════════════╗
║                    CRISIS MONITORING SIMULATION ENGINE                       ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                             ║
║   USER INPUT (5 sliders)                                                    ║
║   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                            ║
║   │ OIL  │ │  FX  │ │ PPI  │ │LABOR │ │ RATE │                            ║
║   │ ±30% │ │ ±15% │ │ ±10% │ │ ±10% │ │±1.5%p│                            ║
║   └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘ └──┬───┘                            ║
║      │        │        │        │        │                                  ║
║      ▼        ▼        ▼        ▼        ▼                                  ║
║   ┌────────────────────────────────────────────┐                            ║
║   │     STEP 1: SHOCK DERIVATION (DAG)         │ s⁰(5) → s¹(10)           ║
║   │     importPrice, steel, cement 파생          │                           ║
║   └───────────────────┬────────────────────────┘                            ║
║                       │                                                     ║
║                       ▼                                                     ║
║   ┌────────────────────────────────────────────┐                            ║
║   │     STEP 2: IRF ENGINE (h = 1..12)         │                            ║
║   │  ┌──────────┐ ┌──────────┐ ┌──────────┐   │                            ║
║   │  │ Gaussian  │ │ ARDL-OLS │ │   LP     │   │                            ║
║   │  │ g(h;μ,σ) │ │ β̂(k,l)   │ │ θ̂(k,h)  │   │                            ║
║   │  └────┬─────┘ └────┬─────┘ └────┬─────┘   │                            ║
║   └───────┼─────────────┼────────────┼─────────┘                            ║
║           │             │            │                                      ║
║           ▼             ▼            ▼                                      ║
║   ┌────────────────────────────────────────────┐                            ║
║   │     STEP 3: COMPOUNDING                    │                            ║
║   │     CC(h) = CC(h-1) × (1 + ΔCC(h)/100)    │                            ║
║   └───────────────────┬────────────────────────┘                            ║
║                       │                                                     ║
║           ┌───────────┼───────────┐                                         ║
║           ▼           ▼           ▼                                         ║
║   ┌──────────┐ ┌──────────┐ ┌──────────┐                                   ║
║   │Sensitiv. │ │ PF Grade │ │Monte     │                                   ║
║   │Analysis  │ │ Impact   │ │Carlo     │                                   ║
║   │ (1-var)  │ │ (5등급)  │ │(N=500+)  │                                   ║
║   └──────────┘ └──────────┘ └──────────┘                                   ║
║                                                                             ║
╚═══════════════════════════════════════════════════════════════════════════════╝
```

---

## 2. Indicator Taxonomy

### 2.1 Primary Drivers (User-Controllable, Exogenous)

| Key          | Label        | Unit    | Slider Range | Nature         |
|-------------|-------------|---------|-------------|----------------|
| `oil`        | 국제유가     | USD/bbl | ±30%        | Commodity      |
| `fx`         | 원/달러 환율 | KRW     | ±15%        | FX             |
| `ppi`        | 생산자물가   | index   | ±10%        | Price Level    |
| `labor`      | 건설노임     | index   | ±10%        | Labor Market   |
| `policyRate` | 기준금리     | %       | ±1.5%p      | Monetary Policy|

### 2.2 Derived Drivers (Computed from Primaries via DAG)

| Key           | Label        | Derivation Formula                              |
|--------------|-------------|------------------------------------------------|
| `importPrice` | 수입물가     | `fx × 0.45 + oil × 0.35 + ppi × 0.20`          |
| `steel`       | 철강 가격    | `importPrice × 0.40 + ppi × 0.35 + oil × 0.15` |
| `cement`      | 시멘트 가격  | `ppi × 0.55 + oil × 0.25`                       |

### 2.3 External Macro (Fixed at 0 in current UI, observable)

| Key     | Label         | Unit | Source        |
|--------|--------------|------|--------------|
| `vix`   | VIX 공포지수  | pt   | Yahoo Finance |
| `us10y` | US 10Y 국채   | %    | Yahoo Finance |

### 2.4 Target Variable

| Key                | Label      | Unit  | Description                    |
|-------------------|-----------|-------|-------------------------------|
| `constructionCost` | 건설공사비  | index | 종합 건설공사비지수 (2020=100) |

---

## 3. Network Topology — DAG

```
Layer 0             Layer 1              Layer 2              Layer 3 (Target)
(Exogenous)         (1st Derived)        (2nd Derived)
═══════════         ═════════════        ═════════════        ═════════════════

                         ┌──── w=0.12 ────────────────────┐
                         │                                 │
  ╔═══════╗              │                                 │
  ║  FX   ║──── 0.45 ───┤                                 │
  ╚═══════╝              │                                 │
      │                  ▼                                 │
      │            ┌───────────┐                           │
      │            │ importPr. │──── w=0.18 ───────────────┤
      │            └─────┬─────┘                           │
      │                  │ 0.40                            │
  ╔═══════╗              │              ┌───────────┐      │
  ║  OIL  ║──── 0.35 ───┤     ┌───────►│  STEEL    │── w=0.14 ──┤
  ╚═══════╝              │     │        └───────────┘      │
      │                  │     │                           │
      ├──── 0.15 ────────┼─────┘                           │
      │                  │                                 │
      ├──── w=0.07 ──────┼─────────────────────────────────┤
      │                  │                                 │
      │                  │                                 ▼
      │                  │                          ╔═════════════╗
      └──── 0.25 ───┐    │                          ║ CONSTRUCTION║
                     │    │                          ║    COST     ║
  ╔═══════╗          │    │                          ╚══════▲══════╝
  ║  PPI  ║── 0.20 ──┘   │                                 │
  ╚═══════╝               │                                 │
      │                   │         ┌───────────┐           │
      ├──── 0.35 ─────────┘    ┌───►│  CEMENT   │── w=0.05 ┤
      │                        │    └───────────┘           │
      ├──── 0.55 ──────────────┘                            │
      │                                                     │
      └──── w=0.13 ────────────────────────────────────────┤
                                                            │
  ╔═══════╗                                                 │
  ║ LABOR ║──── w=0.19 ────────────────────────────────────┤
  ╚═══════╝                                                 │
                                                            │
  ╔═══════╗                                                 │
  ║ RATE  ║──── w=0.07 ────────────────────────────────────┤
  ╚═══════╝                                                 │
                                                            │
  ╔═══════╗                                                 │
  ║  VIX  ║──── w=0.02 ────────────────────────────────────┤
  ╚═══════╝                                                 │
                                                            │
  ╔═══════╗                                                 │
  ║ US10Y ║──── w=0.03 ────────────────────────────────────┘
  ╚═══════╝
```

### 3.1 Edge Weight Table (DAG Internal)

| From → To       | Weight | Economic Rationale                              |
|----------------|--------|------------------------------------------------|
| fx → importPr.  | 0.45   | 수입가격의 45%는 환율 변동에 직접 연동            |
| oil → importPr. | 0.35   | 원유는 석유화학·운송비를 통해 수입물가에 35% 기여  |
| ppi → importPr. | 0.20   | 국내 생산자물가가 수입 대체재 가격에 20% 반영      |
| importPr.→steel | 0.40   | 수입철강·비철이 철강가의 40%를 구성                |
| ppi → steel     | 0.35   | 국내 제강 원가(전기료·인건비)가 35%                |
| oil → steel     | 0.15   | 전기로 에너지비 + 물류비가 15%                    |
| ppi → cement    | 0.55   | 시멘트는 국내 제조 비중이 높아 PPI에 55% 연동      |
| oil → cement    | 0.25   | 소성로 연료비(유연탄·중유)가 25%                   |

### 3.2 Derived Shock Verification

```
importPrice derivation weights: 0.45 + 0.35 + 0.20 = 1.00  ✓
steel derivation weights:       0.40 + 0.35 + 0.15 = 0.90  (≈1, 10% 국내 자체 변동분)
cement derivation weights:      0.55 + 0.25         = 0.80  (20% 독자적 수급 변동)
```

---

## 4. Adjacency Matrix W

W[i][j] = "source j가 target i에 미치는 직접 영향 가중치"

```
                 oil    fx    ppi    impP   labor  steel  cemnt  rate   vix    us10y
              ┌──────────────────────────────────────────────────────────────────────┐
  oil         │  —      0      0      0      0      0      0     0      0      0   │
  fx          │  0      —      0      0      0      0      0     0      0      0   │
  ppi         │  0      0      —      0      0      0      0     0      0      0   │
  importPr.   │ 0.35   0.45   0.20    —      0      0      0     0      0      0   │
  labor       │  0      0      0      0      —      0      0     0      0      0   │
  steel       │ 0.15    0     0.35   0.40    0      —      0     0      0      0   │
  cement      │ 0.25    0     0.55    0      0      0      —     0      0      0   │
  rate        │  0      0      0      0      0      0      0     —      0      0   │
  vix         │  0      0      0      0      0      0      0     0      —      0   │
  us10y       │  0      0      0      0      0      0      0     0      0      —   │
              └──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Matrix Properties

- **Type**: Lower-triangular sparse (DAG structure, no cycles)
- **Dimension**: 10 × 10
- **Non-zero entries**: 8 (density = 8/90 = 8.9%)
- **Spectral radius**: < 1.0 (stable, no explosive feedback)
- **Topological sort order**: `[oil, fx, ppi, labor, rate, vix, us10y] → [importPrice] → [steel, cement]`

---

## 5. Pass-Through Vector P

P[i] = "driver i가 건설공사비에 미치는 **최종 직접** 가중치" (Gaussian method)

```
P = ┌─────────────────────────────────────────────────────────────────────────┐
    │  oil     fx     ppi    impP   labor  steel  cemnt  rate   vix    us10y │
    │  0.07    0.12   0.13   0.18   0.19   0.14   0.05   0.07   0.02   0.03 │
    └─────────────────────────────────────────────────────────────────────────┘
                                                                   Σ = 1.00
```

### 5.1 Temporal Parameters (Peak Lag μ, Width σ)

| i  | Driver       | P[i]  | μ (months) | σ (months) | Interpretation                        |
|----|-------------|-------|------------|------------|--------------------------------------|
| 0  | oil          | 0.07  | 2          | 1.2        | 빠른 충격, 단기 집중                    |
| 1  | fx           | 0.12  | 3          | 1.5        | 수입가 경유 중기 전파                   |
| 2  | ppi          | 0.13  | 2          | 1.5        | 제조원가 경유, 넓은 분산                |
| 3  | importPrice  | 0.18  | 3          | 1.4        | **최대 가중치 2위**, 자재단가 핵심      |
| 4  | labor        | 0.19  | 1          | 1.1        | **최대 가중치 1위**, 즉시 반영         |
| 5  | steel        | 0.14  | 2          | 1.3        | 구조재 비중에 비례                     |
| 6  | cement       | 0.05  | 1          | 1.2        | 기초공사 단기 반영                     |
| 7  | policyRate   | 0.07  | 4          | 1.8        | 장기 파급, 사업성 경유                 |
| 8  | vix          | 0.02  | 1          | 0.8        | 급격하고 짧은 충격                     |
| 9  | us10y        | 0.03  | 5          | 2.0        | 가장 느린 전파, 글로벌 금리 경유       |

### 5.2 IRF Profile Visualization (h = 1..12)

```
h=       1    2    3    4    5    6    7    8    9   10   11   12
       ─────────────────────────────────────────────────────────
oil    ▓▓▓▓ ████ ▓▓▓▓  ░░   ·    ·    ·    ·    ·    ·    ·    ·
fx      ░░  ▓▓▓▓ ████ ▓▓▓▓  ░░   ·    ·    ·    ·    ·    ·    ·
ppi    ▓▓▓▓ ████ ▓▓▓▓  ░░   ░░   ·    ·    ·    ·    ·    ·    ·
impP    ░░  ▓▓▓▓ ████ ▓▓▓▓  ░░   ·    ·    ·    ·    ·    ·    ·
labor  ████ ▓▓▓▓  ░░   ·    ·    ·    ·    ·    ·    ·    ·    ·
steel  ▓▓▓▓ ████ ▓▓▓▓  ░░   ·    ·    ·    ·    ·    ·    ·    ·
cemnt  ████ ▓▓▓▓  ░░   ░░   ·    ·    ·    ·    ·    ·    ·    ·
rate    ·    ░░  ▓▓▓▓ ████ ▓▓▓▓  ░░   ░░   ·    ·    ·    ·    ·
vix    ████ ▓▓▓▓  ·    ·    ·    ·    ·    ·    ·    ·    ·    ·
us10y   ·    ·    ░░  ▓▓▓▓ ████ ▓▓▓▓  ░░   ░░   ·    ·    ·    ·
       ─────────────────────────────────────────────────────────
       ████ = peak (g > 0.8)   ▓▓▓▓ = strong (0.4-0.8)
        ░░  = weak (0.1-0.4)    ·   = negligible (< 0.1)
```

---

## 6. Shock Derivation (DAG Traversal)

### 6.1 Input: User Slider Vector (5D)

```
s⁰ = [ Δoil, Δfx, Δppi, Δlabor, Δrate ]
       (%Δ)   (%Δ)  (%Δ)  (%Δ)   (%pΔ)
```

### 6.2 Derivation Rules (Topological Order)

```
STEP 1:  importPrice = fx × 0.45 + oil × 0.35 + ppi × 0.20

STEP 2a: steel  = importPrice × 0.40 + ppi × 0.35 + oil × 0.15
STEP 2b: cement = ppi × 0.55 + oil × 0.25
         (2a, 2b are independent — can parallelize)

STEP 3:  vix = 0,  us10y = 0   (external, not user-driven)
```

### 6.3 Output: Full Shock Vector (10D)

```
s¹ = [ oil, fx, ppi, importPrice, labor, steel, cement, policyRate, vix, us10y ]
       ↑    ↑    ↑        ↑          ↑      ↑       ↑       ↑        ↑     ↑
      user user user   derived      user  derived derived  user     ext   ext
```

### 6.4 Numerical Example — 유가급등 프리셋

```
Input:  s⁰ = [ oil=30, fx=5, ppi=3, labor=0, rate=0 ]

Step 1: importPrice = 5×0.45 + 30×0.35 + 3×0.20
                    = 2.25   + 10.50    + 0.60
                    = 13.35

Step 2a: steel = 13.35×0.40 + 3×0.35 + 30×0.15
               = 5.34       + 1.05    + 4.50
               = 10.89

Step 2b: cement = 3×0.55 + 30×0.25
               = 1.65    + 7.50
               = 9.15

Output: s¹ = [ 30, 5, 3, 13.35, 0, 10.89, 9.15, 0, 0, 0 ]
```

### 6.5 Matrix Form

```
s¹ = W · s⁰_extended + s⁰_extended

where s⁰_extended = [ oil, fx, ppi, 0, labor, 0, 0, rate, 0, 0 ]

In practice, the DAG is evaluated sequentially because steel depends on importPrice.
The matrix form is:

s¹ = (I + W + W²) · s⁰_extended

since W is nilpotent (W³ = 0 for this DAG depth of 2).
```

---

## 7. Method A: Gaussian IRF

### 7.1 Kernel Function

```
g(h; μᵢ, σᵢ) = exp( -(h - μᵢ)² / (2 × σᵢ²) )

where:
  h  = forecast horizon (months, 1..12)
  μᵢ = peak lag for driver i (months)
  σᵢ = width (dispersion) for driver i (months)
```

### 7.2 Forecast Algorithm

```
FOR h = 1 TO 12:

  1. Inertia (momentum from recent data):
     avgMoM = mean( last 6 months of costMoM )
     inertia(h) = max(0.1, avgMoM × exp(-h/10))

  2. Baseline growth (no-shock trend):
     baseGr(h) = 0.17 + inertia(h) × 0.46

  3. Shock-induced growth:
     shockGr(h) = Σᵢ₌₀⁹  s¹ᵢ × Pᵢ × g(h; μᵢ, σᵢ) × 0.1
                        ↑       ↑       ↑              ↑
                   shock val  weight  temporal kernel  scaling

  4. Compounding:
     baseIdx(h)  = baseIdx(h-1) × (1 + baseGr(h) / 100)
     scIdx(h)    = scIdx(h-1)   × (1 + (baseGr(h) + shockGr(h)) / 100)

  5. Delta:
     deltaPct(h) = (scIdx(h) / baseIdx(h) - 1) × 100
```

### 7.3 Numerical Trace — 유가급등 (oil=+30%, fx=+5%)

```
s¹ = [ 30, 5, 3, 13.35, 0, 10.89, 9.15, 0, 0, 0 ]
P  = [ .07, .12, .13, .18, .19, .14, .05, .07, .02, .03 ]

h=1: shockGr = 30×.07×g(1,2,1.2)×.1 + 5×.12×g(1,3,1.5)×.1 + ...
     where g(1,2,1.2) = exp(-(1-2)²/(2×1.44)) = exp(-0.347) = 0.707

     oil  contribution at h=1: 30 × 0.07 × 0.707 × 0.1 = 0.148
     fx   contribution at h=1:  5 × 0.12 × 0.411 × 0.1 = 0.025
     ppi  contribution at h=1:  3 × 0.13 × 0.707 × 0.1 = 0.028
     impP contribution at h=1: 13.35×0.18× 0.411 × 0.1 = 0.099
     stl  contribution at h=1: 10.89×0.14× 0.707 × 0.1 = 0.108
     cmnt contribution at h=1:  9.15×0.05× 1.000 × 0.1 = 0.046
     ──────────────────────────────────────────────────────
     shockGr(1) ≈ 0.454  (% 추가 성장률)

h=2: g(2,2,1.2) = 1.000 (oil peak!)
     oil  at h=2: 30 × 0.07 × 1.000 × 0.1 = 0.210  (peak)
     ...total shockGr(2) ≈ 0.62

h=3: oil decays, importPrice peaks
     impP at h=3: 13.35 × 0.18 × 1.000 × 0.1 = 0.240  (peak)
     ...
```

---

## 8. Method B: ARDL-OLS

### 8.1 Model Specification

```
ΔCC_t = α + Σ_{k∈DRIVERS} Σ_{l=0}^{maxLag} β_{k,l} × ΔX_{k,t-l} + ε_t

where:
  ΔCC_t   = ((CC_t / CC_{t-1}) - 1) × 100    (% change)
  ΔX_{k,t} = same for driver k (% for levels, diff for rates)
  maxLag  = 4 months
  k ∈ {fx, oil, ppi, importPrice, labor, steel, cement, policyRate, vix, us10y}
```

### 8.2 Design Matrix Structure

```
X = [ 1,  ΔX_fx,t,   ΔX_fx,t-1,   ..., ΔX_fx,t-4,
          ΔX_oil,t,  ΔX_oil,t-1,  ..., ΔX_oil,t-4,
          ...
          ΔX_us10y,t, ΔX_us10y,t-1, ..., ΔX_us10y,t-4 ]

Dimensions:
  Columns = 1 + 10 drivers × 5 lags = 51 parameters
  Rows = T - maxLag  (effective observations)

  With 60 months data:  T = 59 changes, T_eff = 55 observations
  → 55 obs / 51 params — tight fit → regularization implicit via period selection
```

### 8.3 OLS Estimation

```
β̂ = (X'X)⁻¹ X'y

Implementation (no external library):
  1. X' = matTranspose(X)           O(mn)
  2. X'X = matMul(X', X)            O(mn²)
  3. (X'X)⁻¹ = matInvert(X'X)      O(n³) via Gauss-Jordan with partial pivoting
  4. X'y = matVecMul(X', y)         O(mn)
  5. β̂ = matVecMul((X'X)⁻¹, X'y)   O(n²)

  Total: O(mn² + n³) where m = #obs, n = #params

R² = 1 - SS_res / SS_tot
  SS_res = Σ(yᵢ - ŷᵢ)²
  SS_tot = Σ(yᵢ - ȳ)²
```

### 8.4 IRF Extraction

```
ardlIRF(model, driverKey, h):
  IF h <= maxLag AND coeffs[driverKey][h] exists:
    RETURN coeffs[driverKey][h]    ← β_{k,h} coefficient
  ELSE:
    RETURN 0                       ← impulse has decayed
```

**Key difference from Gaussian**: ARDL uses empirically estimated coefficients, not parametric kernel. The IRF can be negative, non-monotonic, and asymmetric.

### 8.5 Forecast Construction

```
FOR h = 1 TO 12:
  inertia(h) = max(0.1, avgMoM × exp(-h/10))
  baseGr(h)  = ardlModel.intercept + inertia(h) × 0.3

  shockGr(h) = Σᵢ  s¹ᵢ × ardlIRF(model, key_i, h) × 0.1
                         ↑                              ↑
                    per-horizon coefficient         scaling factor

  scIdx(h) = scIdx(h-1) × (1 + (baseGr(h) + shockGr(h)) / 100)
```

**IMPORTANT**: ARDL uses `ardlIRF(model, key, h)` (per-horizon coefficient), NOT cumulative sum. The compounding in Step 4 already handles accumulation.

---

## 9. Method C: Local Projections (Jordà 2005)

### 9.1 Model Specification

```
For each horizon h = 1..12:

  y_{t+h} - y_t = α_h + Σ_{k∈DRIVERS} θ_{k,h} × ΔX_{k,t} + ε_{t,h}

where:
  y_{t+h} - y_t = Σ_{s=1}^{h} ΔCC_{t+s}    (cumulative forward change)
  θ_{k,h} = direct h-step-ahead response coefficient

Each horizon h is a SEPARATE regression (12 independent OLS regressions).
```

### 9.2 Design Matrix (per horizon h)

```
X_h = [ 1,  ΔX_fx,t,  ΔX_oil,t,  ..., ΔX_us10y,t ]

Dimensions:
  Columns = 1 + 10 = 11 parameters
  Rows = T_eff = n - h

  → Much better identified than ARDL (11 vs 51 params)
  → Allows nonlinear and horizon-dependent responses
```

### 9.3 Advantages over ARDL

| Feature                    | ARDL-OLS                | Local Projections        |
|---------------------------|------------------------|--------------------------|
| # of regressions           | 1                      | 12 (one per horizon)     |
| # parameters per regression| 51                     | 11                       |
| Misspecification robustness| Low (all lags jointly)  | High (direct estimation) |
| Nonlinear responses        | Restricted              | Naturally captured       |
| Cumulative vs marginal     | Marginal (per-lag β)   | Cumulative (direct θ)    |
| Estimation efficiency      | Higher (if spec correct)| Lower (wider CI)         |

### 9.4 Forecast Construction

```
FOR h = 1 TO 12:
  lp = lpModel.coeffs[h]

  baseCumGr(h)  = lp.intercept          ← cumulative baseline over h months
  shockCumGr(h) = Σᵢ  s¹ᵢ × lp[key_i] × 0.1

  baseline(h) = CC₀ × (1 + baseCumGr(h) / 100)      ← NOT compounded (cumulative)
  scenario(h) = CC₀ × (1 + (baseCumGr(h) + shockCumGr(h)) / 100)
```

**KEY DIFFERENCE**: LP is already cumulative, so NO sequential compounding is needed. `baseCumGr(h)` represents the total change over h months directly.

---

## 10. Ensemble Forecast

### 10.1 Multi-Method Aggregation

```
buildMultiMethodForecast(series, shocks, periodKey):
  gaussian = buildForecastGaussian(series, shocks)
  ardl     = buildForecastARDL(series, shocks, ardlModel)    // null if estimation fails
  lp       = buildForecastLP(series, shocks, lpModel)        // null if estimation fails

  RETURN { gaussian, ardl, lp, models }
```

### 10.2 Method Selection Logic

| `currentSimMethod` | Behavior                                     |
|--------------------|--------------------------------------------|
| `'gaussian'`       | Only Gaussian IRF                            |
| `'ardl'`           | ARDL if model exists, else fallback Gaussian |
| `'lp'`             | LP if model exists, else fallback Gaussian   |
| `'all'`            | Run all 3, display side by side              |

### 10.3 KPI Display Format

```
┌──────────────────────────────────────────────────────────────────┐
│  3M 추가압력    6M 추가압력    12M 추가압력    공사비 평균영향   │
│  (G/A/L)       (G/A/L)       (G/A/L)        (12M avg of 3)    │
│  +0.42%        +0.85%        +1.31%         +1.24%            │
│  +0.38/+0.45   +0.79/+0.91   +1.18/+1.42    ← per method     │
│  /+0.39        /+0.82        /+1.33                           │
└──────────────────────────────────────────────────────────────────┘
```

---

## 11. Multi-Hop Path Decomposition

### 11.1 All Paths: OIL → Construction Cost

```
Path 1  (1-hop direct):
  oil ──(P=0.07)──────────────────────────────────► CC
  Effective weight: 0.07

Path 2  (2-hop via importPrice):
  oil ──(0.35)──► importPrice ──(P=0.18)──────────► CC
  Effective weight: 0.35 × 0.18 = 0.063

Path 3  (3-hop via importPrice → steel):
  oil ──(0.35)──► importPrice ──(0.40)──► steel ──(P=0.14)──► CC
  Effective weight: 0.35 × 0.40 × 0.14 = 0.0196

Path 4  (2-hop via steel directly):
  oil ──(0.15)──► steel ──(P=0.14)────────────────► CC
  Effective weight: 0.15 × 0.14 = 0.021

Path 5  (2-hop via cement):
  oil ──(0.25)──► cement ──(P=0.05)────────────────► CC
  Effective weight: 0.25 × 0.05 = 0.0125

                                              ──────────
Total effective oil → CC:                      0.186
  Direct:   0.070  (37.6%)
  Indirect: 0.116  (62.4%)
```

### 11.2 All Paths: FX → Construction Cost

```
Path 1  (1-hop direct):
  fx ──(P=0.12)───────────────────────────────────► CC
  Effective weight: 0.12

Path 2  (2-hop via importPrice):
  fx ──(0.45)──► importPrice ──(P=0.18)───────────► CC
  Effective weight: 0.45 × 0.18 = 0.081

Path 3  (3-hop via importPrice → steel):
  fx ──(0.45)──► importPrice ──(0.40)──► steel ──(P=0.14)──► CC
  Effective weight: 0.45 × 0.40 × 0.14 = 0.0252

                                              ──────────
Total effective fx → CC:                       0.226
  Direct:   0.120  (53.1%)
  Indirect: 0.106  (46.9%)
```

### 11.3 All Paths: PPI → Construction Cost

```
Path 1  (1-hop direct):
  ppi ──(P=0.13)──────────────────────────────────► CC     = 0.130

Path 2  (2-hop via importPrice):
  ppi ──(0.20)──► importPrice ──(P=0.18)──────────► CC     = 0.036

Path 3  (3-hop via importPrice → steel):
  ppi ──(0.20)──► importPrice ──(0.40)──► steel ──(P=0.14)─► CC = 0.0112

Path 4  (2-hop via steel):
  ppi ──(0.35)──► steel ──(P=0.14)────────────────► CC     = 0.049

Path 5  (2-hop via cement):
  ppi ──(0.55)──► cement ──(P=0.05)───────────────► CC     = 0.0275

                                              ──────────
Total effective ppi → CC:                      0.254
  Direct:   0.130  (51.2%)
  Indirect: 0.124  (48.8%)
```

### 11.4 Total Effective Weight Summary

```
┌──────────────┬─────────┬──────────┬──────────┬─────────┐
│ Driver       │ Direct  │ Indirect │ Total    │ Rank    │
├──────────────┼─────────┼──────────┼──────────┼─────────┤
│ ppi          │ 0.130   │ 0.124    │ 0.254    │ 1 ★     │
│ fx           │ 0.120   │ 0.106    │ 0.226    │ 2 ★     │
│ labor        │ 0.190   │ 0.000    │ 0.190    │ 3       │
│ oil          │ 0.070   │ 0.116    │ 0.186    │ 4       │
│ policyRate   │ 0.070   │ 0.000    │ 0.070    │ 5       │
│ us10y        │ 0.030   │ 0.000    │ 0.030    │ 6       │
│ vix          │ 0.020   │ 0.000    │ 0.020    │ 7       │
└──────────────┴─────────┴──────────┴──────────┴─────────┘

※ importPrice, steel, cement are intermediate nodes — their "P weight"
   is already accounted for in the indirect paths of their parents.
```

**Insight**: PPI has the highest *total effective* influence (0.254) despite being ranked 3rd in direct pass-through (P=0.13), because it feeds into importPrice, steel, AND cement simultaneously.

---

## 12. Correlation Dynamics (7×7 Matrix)

### 12.1 Data Source

```
Endpoint: /api/correlation
Method:   5Y monthly aligned series
Keys:     [wti, fedfunds, usdkrw, construction, realestate, vix, us10y]
```

### 12.2 Pearson Correlation Computation

```
ρ(X, Y) = Σᵢ(xᵢ - μₓ)(yᵢ - μᵧ) / √(Σᵢ(xᵢ - μₓ)² × Σᵢ(yᵢ - μᵧ)²)

Implementation (server-side):
  computeCorrelation(xArr, yArr):
    n = length
    if n < 3: return 0
    mx = mean(x), my = mean(y)
    num = Σ (xᵢ - mx)(yᵢ - my)
    dx2 = Σ (xᵢ - mx)²
    dy2 = Σ (yᵢ - my)²
    denom = √(dx2 × dy2)
    return denom === 0 ? 0 : round(num/denom, 3)
```

### 12.3 Matrix Structure (Dynamic, from real data)

```
           WTI    FedFnd  USD/KRW  Constr  RealEst   VIX    US10Y
         ┌──────────────────────────────────────────────────────────┐
  WTI    │ 1.000                                                   │
  FedFnd │  ρ₁₀   1.000                                           │
  USD/KRW│  ρ₂₀    ρ₂₁   1.000                                    │
  Constr │  ρ₃₀    ρ₃₁    ρ₃₂   1.000                             │
  RealEst│  ρ₄₀    ρ₄₁    ρ₄₂    ρ₄₃   1.000                     │
  VIX    │  ρ₅₀    ρ₅₁    ρ₅₂    ρ₅₃    ρ₅₄   1.000              │
  US10Y  │  ρ₆₀    ρ₆₁    ρ₆₂    ρ₆₃    ρ₆₄    ρ₆₅   1.000      │
         └──────────────────────────────────────────────────────────┘

  Expected structural signs:
    ρ(WTI, FedFnd)   > 0   (oil inflation → rate hike)
    ρ(WTI, USD/KRW)  > 0   (oil shock → KRW depreciation)
    ρ(WTI, Constr)   > 0   (oil → material cost → construction)
    ρ(FedFnd, US10Y) > 0   (policy rate → long-term rate)
    ρ(FedFnd, RealEst)< 0   (rate hike → housing cooling)
    ρ(VIX, USD/KRW)  > 0   (risk-off → EM currency weak)
    ρ(VIX, RealEst)  < 0   (uncertainty → investment retreat)
```

### 12.4 UI Rendering

```
Color encoding:
  ρ > 0  →  rgba(0, 200, 83,  |ρ| × 0.7)   (green)
  ρ < 0  →  rgba(220, 53, 69, |ρ| × 0.7)   (red)
  ρ = 1  →  rgba(78, 201, 255, 0.15)         (diagonal, blue)
  null   →  rgba(100, 120, 150, 0.2)         (no data)

Strength classification:
  |ρ| > 0.6  →  "strong"
  |ρ| > 0.3  →  "moderate"
  |ρ| ≤ 0.3  →  "weak"
```

---

## 13. Sensitivity Analysis

### 13.1 Algorithm

```
runSensitivity(variable, horizonIdx):
  baseShocks = getSimShocks()                     ← current slider values
  steps = variable is rate ? [-1.5..+2.0] : [-10..+20]

  FOR each delta in steps:
    shocks = clone(baseShocks)
    shocks[variable] = delta
    forecast = buildScenarioForecast(macroSimData, shocks)

    d3  = forecast[2].deltaPct     ← 3M impact
    d6  = forecast[5].deltaPct     ← 6M impact
    d12 = forecast[11].deltaPct    ← 12M impact

    pressure = buildPressureState(latest, forecast, attribution)

    RECORD (delta, d3, d6, d12, pressure.label)
```

### 13.2 Output Format

```
┌──────────┬──────────┬──────────┬──────────┬──────────────┐
│ Δoil(%)  │ 3M 압력  │ 6M 압력  │ 12M 압력 │ Signal       │
├──────────┼──────────┼──────────┼──────────┼──────────────┤
│ -10      │ -0.12%   │ -0.28%   │ -0.41%   │ STABLE       │
│  -5      │ -0.06%   │ -0.14%   │ -0.21%   │ STABLE       │
│  -2      │ -0.02%   │ -0.06%   │ -0.08%   │ STABLE       │
│   0      │  0.00%   │  0.00%   │  0.00%   │ WATCH        │
│  +2      │ +0.02%   │ +0.06%   │ +0.08%   │ WATCH        │
│  +5      │ +0.06%   │ +0.14%   │ +0.21%   │ WATCH        │
│ +10      │ +0.12%   │ +0.28%   │ +0.41%   │ WATCH        │
│ +20      │ +0.23%   │ +0.55%   │ +0.82%   │ HIGH PRESSURE│
└──────────┴──────────┴──────────┴──────────┴──────────────┘
```

---

## 14. Monte Carlo Simulation

### 14.1 Random Shock Generation

```
FOR i = 1 TO N (500~1000 iterations):

  shocks[i] = {
    fx:         base.fx         + Z₁ × σ_fx          (Z ~ N(0,1))
    oil:        base.oil        + Z₂ × σ_oil
    ppi:        base.ppi        + Z₃ × 1.5
    labor:      base.labor      + Z₄ × 1.0
    policyRate: base.policyRate + Z₅ × 0.3
  }

  forecast[i] = buildScenarioForecast(macroSimData, shocks[i])
  d12[i] = forecast[i][11].deltaPct

where Z = gaussianRandom() using Box-Muller transform:
  u₁, u₂ ~ Uniform(0,1)
  Z = √(-2 ln u₁) × cos(2π u₂)
```

### 14.2 User Parameters

| Parameter    | Default | Description               |
|-------------|---------|--------------------------|
| `iterations` | 500     | Number of MC draws        |
| `oilVol`     | 5.0     | Oil shock std dev (%)     |
| `fxVol`      | 3.0     | FX shock std dev (%)      |

### 14.3 Statistics

```
Output = sorted d12[1..N]:

  Mean     = (1/N) Σ d12[i]
  Std      = √( (1/N) Σ (d12[i] - mean)² )
  VaR(95%) = d12[⌊0.95 × N⌋]           ← 95th percentile
  CVaR     = mean( d12[i] for i > 95th percentile )    ← Expected Shortfall
  P5       = d12[⌊0.05 × N⌋]           ← best case
  P95      = d12[⌊0.95 × N⌋]           ← worst case
```

### 14.4 Histogram

```
  Bins = 20, range = [min(d12), max(d12)]

  Frequency
  │        ██
  │       ████
  │      ██████
  │     ████████
  │    ██████████
  │   ████████████
  │  ██████████████
  │ ████████████████
  └──────────────────────── 12M 추가 압력 (%)
    -0.5    0.0    0.5    1.0    1.5    2.0

  Colors: green (< 30%) → blue (30-70%) → red (> 70%)
```

---

## 15. PF Grade Impact Model

### 15.1 PF Grade Definitions

| Grade    | Base Spread | Risk Profile        | Color   |
|---------|------------|--------------------|---------|
| AA-      | +1.8%p     | 우량 시행사, A급 입지 | #22c55e |
| A        | +2.5%p     | 일반 시행사, 수도권   | #4ec9ff |
| BBB+     | +3.8%p     | 중소 시행사, 광역시   | #f59e0b |
| BBB0     | +5.2%p     | 고위험 시행사, 지방   | #fb7185 |
| BBB- Neg | +7.0%p     | 부실 우려, 워치리스트 | #ff4d6d |

### 15.2 Impact Computation

```
FOR each PF grade g:

  currentPfRate = baseRate + g.baseSpread

  1. Rate Impact (직접):
     rateImpact = shocks.policyRate                    ← slider value in %p

  2. Construction Cost Risk Premium:
     costImpact = ΔCC_12M × 0.15                      ← 공사비 변동의 15%가 PF 금리에 전가

  3. Grade-Adjusted Risk Premium:
     IF ΔCC_12M > 0:
       riskPremium = ΔCC_12M × g.baseSpread × 0.08    ← 공사비↑ × 등급 스프레드 × 민감도
     ELSE:
       riskPremium = ΔCC_12M × g.baseSpread × 0.03    ← 하방은 덜 반영 (비대칭)

  4. Total:
     totalDelta = rateImpact + riskPremium + costImpact
     newPfRate  = currentPfRate + totalDelta
```

### 15.3 Asymmetric Risk Premium

```
                riskPremium
                    │
          ↗ slope = baseSpread × 0.08
         /
        /
───────●──────────────── ΔCC_12M
      / \
     /   ↘ slope = baseSpread × 0.03
    /

BBB- (spread=7.0):
  +1% cost → +7.0 × 0.08 = +0.56%p premium
  -1% cost → -7.0 × 0.03 = -0.21%p premium   (비대칭: 상방 리스크 2.7배)

AA- (spread=1.8):
  +1% cost → +1.8 × 0.08 = +0.14%p premium
  -1% cost → -1.8 × 0.03 = -0.05%p premium
```

### 15.4 Numerical Example — 유가급등

```
Assumptions: baseRate = 2.5%, ΔCC_12M = +1.31%, shocks.policyRate = 0

Grade AA-:
  rateImpact  = 0
  costImpact  = 1.31 × 0.15 = +0.197%p
  riskPremium = 1.31 × 1.8 × 0.08 = +0.189%p
  totalDelta  = 0 + 0.189 + 0.197 = +0.386%p
  newRate     = 2.5 + 1.8 + 0.386 = 4.686%

Grade BBB-:
  rateImpact  = 0
  costImpact  = 1.31 × 0.15 = +0.197%p
  riskPremium = 1.31 × 7.0 × 0.08 = +0.734%p
  totalDelta  = 0 + 0.734 + 0.197 = +0.931%p
  newRate     = 2.5 + 7.0 + 0.931 = 10.431%

→ BBB- 등급은 같은 충격에 AA- 대비 2.4배 더 큰 금리 영향
```

---

## 16. Pressure State Machine

### 16.1 Score Computation

```
score = current × 0.45 + d3 × 1.5 + d12 × 1.2 + topContribution × 0.55

where:
  current          = latest costYoY or costMoM
  d3               = forecast[2].deltaPct   (3M shock delta)
  d12              = forecast[11].deltaPct  (12M shock delta)
  topContribution  = Σ |contribution| of top 3 drivers
```

### 16.2 State Transitions

```
                    score ≥ 4.2
           ┌───────────────────────────────────┐
           │                                   │
           ▼                                   │
    ╔══════════════╗                           │
    ║ HIGH PRESSURE║  tone: #fb7185            │
    ║              ║  원가·금융 축 압력 동시    │
    ╚══════╤═══════╝                           │
           │ score < 4.2                       │
           ▼                                   │
    ╔══════════════╗         score ≥ 2.1       │
    ║    WATCH     ║◄──────────────────────────┘
    ║              ║  tone: #f59e0b
    ║  우상향이나  ║
    ║  통제 가능   ║
    ╚══════╤═══════╝
           │ score < 2.1
           ▼
    ╔══════════════╗
    ║    STABLE    ║  tone: #34d399
    ║  상방 압력   ║
    ║  제한적      ║
    ╚══════════════╝
```

---

## 17. Attribution Engine

### 17.1 Driver Contribution

```
buildAttribution(series, periodKey):
  sub = sliceSeries(series, periodKey)     ← period-specific data
  first = sub[0], last = sub[last]

  FOR each driver k:
    IF k ∈ {policyRate, vix, us10y}:
      change[k] = last[k] - first[k]       ← absolute diff (for rates)
    ELSE:
      change[k] = ((last[k] / first[k]) - 1) × 100   ← % change

    contribution[k] = change[k] × PASS_THROUGH[k].weight

  RETURN sorted by |contribution| DESC
```

### 17.2 Route Summary with Lag Correlation

```
buildRouteSummary(series, attribution):
  FOR each driver k:
    lagCorr = lagCorrelation(series, k, 'constructionCost', maxLag=12)
    bestLag = argmax( |lagCorr[l]| for l=0..12 )
    bestCorr = lagCorr[bestLag]

    score = |bestCorr| × 100 × P[k] + |contribution[k]|

    RETURN {
      driver, path, summary,     ← from ROUTE_BLUEPRINT
      lag: bestLag,              ← optimal lag in months
      corr: bestCorr,           ← correlation at optimal lag
      contribution,             ← from attribution
      score                     ← composite ranking metric
    }

  SORT by score DESC
```

### 17.3 Route Blueprint (Propagation Narratives)

```
fx:    환율 → 수입물가 → 자재단가 → 건설공사비
       환율 상승은 수입자재 단가를 통해 공사비에 중기적으로 반영됩니다.

oil:   유가 → 에너지·운송비 → 자재비 → 건설공사비
       유가 충격은 물류비와 에너지비를 통해 단기에 작동합니다.

ppi:   생산자물가 → 제조원가 → 자재단가 → 건설공사비
       생산자물가 압력은 자재 제조원가를 통해 누적됩니다.

importPrice: 수입물가 → 수입자재 → 건설공사비
       수입물가 상승은 철강·비철 계열 자재가격에 먼저 반영됩니다.

labor: 노무비 → 직접공사비 → 건설공사비
       노무비는 가장 직관적이고 빠르게 단가에 반영되는 축입니다.

steel: 철강가격 → 구조재 → 건설공사비
       철강가격은 구조재 비중이 높은 공종에서 영향력이 큽니다.

cement: 시멘트가격 → 레미콘·기초자재 → 건설공사비
       시멘트는 짧은 시차로 기초 공사비에 반영됩니다.

policyRate: 금리 → 사업성·착공구성 → 공사단가 체감
       금리는 금융비용뿐 아니라 프로젝트 유형 선택까지 바꿉니다.

vix:   VIX → 시장 불확실성 → 투자 위축 → 자재 공급 불안 → 건설공사비
       VIX 급등은 금융 시장 불안을 통해 자재 공급망과 투자를 위축시킵니다.

us10y: US 10Y → 글로벌 금리 → 국내 금리 → 사업성·금융비용 → 건설공사비
       미국 장기 국채 금리는 글로벌 금리 벤치마크로 국내 건설 금융비용에 간접 영향.
```

---

## 18. Analysis Periods

### 18.1 Period Definitions

```
┌──────────┬────────────────────────────────┬────────┬────────────────────────────┐
│ Key      │ Label                          │ Months │ Description                │
├──────────┼────────────────────────────────┼────────┼────────────────────────────┤
│ warEra   │ 우크라 전쟁기 (22.02~23.08)    │ 13→31  │ 공급망 충격 최대 구간       │
│ postWar  │ 전쟁 후 안정기 (23.09~24.06)   │ 32→41  │ 금리 고점, 원자재 안정화    │
│ recent   │ 최근 12개월                    │ 48→59  │ 현재 추세 반영              │
│ full     │ 전체 (21.01~25.12)             │  0→59  │ 60개월 장기 구조 추정       │
└──────────┴────────────────────────────────┴────────┴────────────────────────────┘
```

### 18.2 Period Impact on Model Estimation

```
Period "warEra" (19 months):
  → ARDL: 19 obs, 51 params → CANNOT estimate (underdetermined) → fallback Gaussian
  → LP:   19-h obs, 11 params → Marginal for h > 8 but feasible for h ≤ 8

Period "full" (60 months):
  → ARDL: 55 obs, 51 params → Tight fit, R² may overfit
  → LP:   48~58 obs, 11 params → Well-identified, reliable

Period "recent" (12 months):
  → ARDL: 7 obs → CANNOT estimate → fallback
  → LP:   4~11 obs → Marginal, only low horizons feasible
```

---

## 19. Full Pipeline Flowchart

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   USER ACTION                                                              │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│   │ Slider   │  │ Preset   │  │ Period   │  │ Method   │                  │
│   │ Adjust   │  │ Select   │  │ Switch   │  │ Switch   │                  │
│   └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│        │             │             │             │                         │
│        └──────┬──────┘             │             │                         │
│               ▼                    ▼             ▼                         │
│   ┌───────────────────┐  ┌─────────────────────────────┐                   │
│   │ getSimShocks()    │  │ getModels(series, period)   │                   │
│   │ → 5D → 10D DAG    │  │ → estimateARDL()            │                   │
│   └────────┬──────────┘  │ → estimateLocalProjections()│                   │
│            │             └──────────┬──────────────────┘                   │
│            │                        │                                      │
│            ▼                        ▼                                      │
│   ┌────────────────────────────────────────────────────┐                   │
│   │ buildMultiMethodForecast(series, shocks, period)   │                   │
│   │                                                    │                   │
│   │   ┌──────────┐  ┌──────────┐  ┌──────────┐       │                   │
│   │   │ Gaussian │  │   ARDL   │  │    LP    │       │                   │
│   │   │ 12 pts   │  │ 12 pts   │  │ 12 pts   │       │                   │
│   │   └────┬─────┘  └────┬─────┘  └────┬─────┘       │                   │
│   └────────┼──────────────┼────────────┼──────────────┘                   │
│            │              │            │                                   │
│            ▼              ▼            ▼                                   │
│   ┌────────────────────────────────────────────┐                           │
│   │         RENDER OUTPUTS                     │                           │
│   │                                            │                           │
│   │  ┌─────────────┐  ┌─────────────┐         │                           │
│   │  │ KPI Cards   │  │ IRF Chart   │         │                           │
│   │  │ 3M/6M/12M   │  │ (3 lines)   │         │                           │
│   │  └─────────────┘  └─────────────┘         │                           │
│   │                                            │                           │
│   │  ┌─────────────┐  ┌─────────────┐         │                           │
│   │  │ Attribution │  │ Cumulative  │         │                           │
│   │  │ Table       │  │ Chart       │         │                           │
│   │  └─────────────┘  └─────────────┘         │                           │
│   │                                            │                           │
│   │  ┌─────────────┐  ┌─────────────┐         │                           │
│   │  │ PF Impact   │  │ RE Impact   │         │                           │
│   │  │ (5 grades)  │  │ (평당 단가) │         │                           │
│   │  └─────────────┘  └─────────────┘         │                           │
│   │                                            │                           │
│   │  ┌─────────────┐  ┌─────────────┐         │                           │
│   │  │ Mechanism   │  │ Pressure    │         │                           │
│   │  │ Diagram     │  │ State       │         │                           │
│   │  └─────────────┘  └─────────────┘         │                           │
│   └────────────────────────────────────────────┘                           │
│                                                                             │
│   PARALLEL ANALYSIS TOOLS                                                  │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                    │
│   │ Sensitivity  │  │ Monte Carlo  │  │ Correlation  │                    │
│   │ (1-variable) │  │ (N draws)    │  │ (7×7 matrix) │                    │
│   └──────────────┘  └──────────────┘  └──────────────┘                    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 20. Implementation Reference

### 20.1 Key Functions Map

| Function                    | File:Line     | Purpose                               |
|----------------------------|--------------|--------------------------------------|
| `getSimShocks()`           | html:5565    | 5D→10D shock derivation               |
| `buildForecastGaussian()`  | html:3018    | Method A: Gaussian IRF forecast        |
| `estimateARDL()`           | html:3094    | Method B: ARDL model estimation        |
| `buildForecastARDL()`      | html:3138    | Method B: ARDL forecast                |
| `estimateLocalProjections()` | html:3169  | Method C: LP model estimation          |
| `buildForecastLP()`        | html:3206    | Method C: LP forecast                  |
| `buildMultiMethodForecast()` | html:3252  | Ensemble (all 3 methods)               |
| `buildAttribution()`       | html:3264    | Driver contribution ranking            |
| `buildRouteSummary()`      | html:3276    | Path + lag correlation                 |
| `buildPressureState()`     | html:3286    | HIGH/WATCH/STABLE classification       |
| `runSensitivity()`         | html:5817    | 1-variable sensitivity table           |
| `runMonteCarlo()`          | html:5858    | N-draw stochastic simulation           |
| `renderPfImpact()`         | html:6184    | PF grade rate impact                   |
| `renderCorrelationMatrix()`| html:5031    | 7×7 correlation heatmap                |
| `computeCorrelation()`     | server.js    | Pearson ρ computation (server-side)    |
| `fetchAllHistory()`        | server.js    | 5Y monthly data from Yahoo/FRED/ECOS  |

### 20.2 Data Flow

```
Yahoo Finance ─┐
FRED API ──────┼──► server.js ──► /api/correlation ──► correlationPayload
ECOS API ──────┘               ──► /api/history    ──► historyPayload
                               ──► /api/indicators ──► real-time quotes

60-month synthetic series ──► macroSimData ──► All simulation functions
```

### 20.3 Caching Strategy

| Cache              | TTL       | Storage         | Key                        |
|-------------------|-----------|-----------------|---------------------------|
| Correlation API    | 30 min    | Server memory   | `corrCache`                |
| History API        | 30 min    | Server memory   | `histCache`                |
| Correlation client | 1 hour    | localStorage    | `insight-corr-5y-v1`      |
| History client     | 1 hour    | localStorage    | `insight-history-5y-v1`   |
| ARDL/LP models     | Per-session| JS memory      | `_modelCache[periodKey]`  |
| Indicator API      | 60 sec    | Server memory   | `indicatorCache`           |

---

*Generated from `crisis-monitoring-dashboard.html` + `server.js` codebase analysis.*
