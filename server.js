const http = require('http');
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
        return;
    }

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    lines.forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            return;
        }

        const eqIndex = trimmed.indexOf('=');
        if (eqIndex < 0) {
            return;
        }

        const key = trimmed.slice(0, eqIndex).trim();
        let value = trimmed.slice(eqIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }

        if (!(key in process.env)) {
            process.env[key] = value;
        }
    });
}

loadDotEnv();

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_FILE = path.join(__dirname, 'crisis-monitoring-dashboard.html');

const ECOS_API_KEY = process.env.ECOS_API_KEY || '';
const FRED_API_KEY = process.env.FRED_API_KEY || '';
const FASTFOREX_ACCOUNT = process.env.FASTFOREX_ACCOUNT || '';
const FASTFOREX_API_KEY = process.env.FASTFOREX_API || process.env.FASTFOREX_API_KEY || '';
const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY || process.env.ALPHA_VANTAGE || '';
const AISSTREAM_API_KEY = process.env.AISSTREAM_API_KEY || process.env.AISSTREAM || '';
const NEWS_SOURCES = Object.freeze([
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
    { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC' },
    { url: 'https://feeds.reuters.com/reuters/worldNews', name: 'Reuters' },
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'NYT' },
    { url: 'https://feeds.bloomberg.com/markets/news.rss', name: 'Bloomberg' },
    { url: 'https://www.ft.com/?format=rss', name: 'Financial Times' }
]);

const CACHE_TTL_MS = 60 * 1000;
const NEWS_CACHE_TTL_MS = 3 * 60 * 1000;
const MAX_NEWS_ITEMS = 24;
let indicatorCache = {
    expiresAt: 0,
    payload: null
};
let newsCache = {
    expiresAt: 0,
    payload: null
};

function toNumber(value) {
    const normalized = String(value ?? '').replace(/,/g, '').trim();
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function toPercentNumber(value) {
    const normalized = String(value ?? '').replace('%', '').trim();
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function sendJson(res, statusCode, body) {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(payload);
}

function sendHtml(res, html) {
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(html);
}

async function fetchJson(url) {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'insight-dashboard/1.0' }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'insight-dashboard/1.0',
            Accept: 'application/rss+xml, application/xml, text/xml, */*'
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
}

function escapeRegExp(input) {
    return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(text) {
    const named = {
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
        '&quot;': '"',
        '&#39;': "'",
        '&apos;': "'",
        '&nbsp;': ' '
    };
    const withNamed = String(text).replace(
        /&(amp|lt|gt|quot|#39|apos|nbsp);/g,
        (entity) => named[entity] ?? entity
    );

    return withNamed
        .replace(/&#(\d+);/g, (_, num) => {
            const code = Number.parseInt(num, 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        })
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
            const code = Number.parseInt(hex, 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : _;
        });
}

function stripCdata(text) {
    const value = String(text ?? '').trim();
    if (value.startsWith('<![CDATA[') && value.endsWith(']]>')) {
        return value.slice(9, -3);
    }
    return value;
}

function collapseWhitespace(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function stripHtml(text) {
    return String(text ?? '').replace(/<[^>]*>/g, ' ');
}

function cleanXmlText(text, { stripMarkup = false } = {}) {
    const value = stripMarkup ? stripHtml(text) : text;
    return collapseWhitespace(decodeEntities(stripCdata(value)));
}

function parseDateToIso(rawDate) {
    const parsed = new Date(rawDate);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractTagText(block, tags, options = {}) {
    for (const tag of tags) {
        const expr = new RegExp(`<${escapeRegExp(tag)}\\b[^>]*>([\\s\\S]*?)</${escapeRegExp(tag)}>`, 'i');
        const match = expr.exec(block);
        if (match?.[1]) {
            return cleanXmlText(match[1], options);
        }
    }
    return '';
}

function extractRssLink(itemBlock) {
    const attrMatch = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(itemBlock);
    if (attrMatch?.[1]) {
        return cleanXmlText(attrMatch[1]);
    }
    const linkText = extractTagText(itemBlock, ['link', 'guid', 'id']);
    return linkText;
}

function extractAtomLink(entryBlock) {
    const alternate = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryBlock);
    if (alternate?.[1]) {
        return cleanXmlText(alternate[1]);
    }

    const href = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryBlock);
    if (href?.[1]) {
        return cleanXmlText(href[1]);
    }

    return extractTagText(entryBlock, ['link', 'id']);
}

function parseRssItems(xml, sourceName) {
    const blocks = [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
    return blocks
        .map(([, block]) => {
            const title = extractTagText(block, ['title']);
            const link = extractRssLink(block);
            const publishedAt = parseDateToIso(
                extractTagText(block, ['pubDate', 'dc:date', 'updated', 'published'])
            );
            const summary = extractTagText(block, ['description', 'content:encoded', 'summary'], { stripMarkup: true });
            return {
                source: sourceName,
                title,
                link,
                summary,
                publishedAt
            };
        })
        .filter((item) => item.title && item.link);
}

function parseAtomItems(xml, sourceName) {
    const blocks = [...String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
    return blocks
        .map(([, block]) => {
            const title = extractTagText(block, ['title']);
            const link = extractAtomLink(block);
            const publishedAt = parseDateToIso(
                extractTagText(block, ['updated', 'published', 'dc:date'])
            );
            const summary = extractTagText(block, ['summary', 'content'], { stripMarkup: true });
            return {
                source: sourceName,
                title,
                link,
                summary,
                publishedAt
            };
        })
        .filter((item) => item.title && item.link);
}

function getFallbackNewsItems() {
    const now = Date.now();
    return [
        {
            source: 'System',
            title: 'Live RSS feeds are unavailable. Showing fallback headlines.',
            link: '',
            summary: 'Unable to fetch remote RSS sources from this environment.',
            publishedAt: new Date(now).toISOString()
        },
        {
            source: 'System',
            title: 'Run the dashboard server with outbound internet access to enable live news.',
            link: '',
            summary: 'The /api/news endpoint aggregates Reuters, BBC, NYT, Bloomberg, and other sources.',
            publishedAt: new Date(now - 5 * 60 * 1000).toISOString()
        }
    ];
}

async function buildNewsPayload() {
    const warnings = [];
    const sourceItems = await Promise.all(
        NEWS_SOURCES.map(async (source) => {
            try {
                const xml = await fetchText(source.url);
                const rssItems = parseRssItems(xml, source.name);
                const atomItems = parseAtomItems(xml, source.name);
                const merged = [...rssItems, ...atomItems];
                if (merged.length === 0) {
                    warnings.push(`${source.name} empty feed`);
                }
                return merged;
            } catch (error) {
                warnings.push(`${source.name} failed: ${error.message}`);
                return [];
            }
        })
    );

    const deduped = [];
    const seen = new Set();
    sourceItems.flat().forEach((item) => {
        const key = `${item.link}|${item.title}`.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        deduped.push({
            ...item,
            publishedAt: item.publishedAt || null
        });
    });

    deduped.sort((a, b) => {
        const left = a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const right = b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return right - left;
    });

    const items = deduped.slice(0, MAX_NEWS_ITEMS);
    if (items.length === 0) {
        warnings.push('no live news items');
    }

    return {
        items: items.length > 0 ? items : getFallbackNewsItems(),
        timestamp: new Date().toISOString(),
        warnings
    };
}

async function getNews() {
    const now = Date.now();
    if (newsCache.payload && newsCache.expiresAt > now) {
        return newsCache.payload;
    }

    const payload = await buildNewsPayload();
    newsCache = {
        payload,
        expiresAt: now + NEWS_CACHE_TTL_MS
    };
    return payload;
}

async function fetchFredLatest(seriesId) {
    if (!FRED_API_KEY) {
        return null;
    }

    const url = new URL('https://api.stlouisfed.org/fred/series/observations');
    url.searchParams.set('series_id', seriesId);
    url.searchParams.set('api_key', FRED_API_KEY);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('sort_order', 'desc');
    url.searchParams.set('limit', '12');

    const data = await fetchJson(url.toString());
    const rows = Array.isArray(data.observations) ? data.observations : [];
    for (const row of rows) {
        const parsed = toNumber(row.value);
        if (parsed !== null) {
            return parsed;
        }
    }
    return null;
}

async function fetchBokBaseRate() {
    if (!ECOS_API_KEY) {
        return null;
    }

    const now = new Date();
    const endYear = now.getFullYear();
    const endMonth = String(now.getMonth() + 1).padStart(2, '0');
    const end = `${endYear}${endMonth}`;
    const start = `${endYear - 3}01`;

    const url =
        `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_API_KEY}/json/kr/1/240/` +
        `722Y001/M/${start}/${end}/0101000`;

    const data = await fetchJson(url);
    const rows = data?.StatisticSearch?.row;
    if (!Array.isArray(rows)) {
        return null;
    }

    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const parsed = toNumber(rows[i]?.DATA_VALUE);
        if (parsed !== null) {
            return parsed;
        }
    }
    return null;
}

async function fetchFastForexUsdKrw() {
    if (!FASTFOREX_API_KEY) {
        return null;
    }

    const url = new URL('https://api.fastforex.io/fetch-one');
    url.searchParams.set('from', 'USD');
    url.searchParams.set('to', 'KRW');
    url.searchParams.set('api_key', FASTFOREX_API_KEY);
    if (FASTFOREX_ACCOUNT) {
        url.searchParams.set('account', FASTFOREX_ACCOUNT);
    }

    const data = await fetchJson(url.toString());
    const direct =
        toNumber(data?.result?.KRW) ??
        toNumber(data?.result?.krw) ??
        toNumber(data?.result);

    return direct;
}

async function fetchAlphaVantageGlobalQuote(symbol) {
    if (!ALPHA_VANTAGE_API_KEY) {
        return null;
    }

    const url = new URL('https://www.alphavantage.co/query');
    url.searchParams.set('function', 'GLOBAL_QUOTE');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('apikey', ALPHA_VANTAGE_API_KEY);

    const data = await fetchJson(url.toString());
    const quote = data?.['Global Quote'];
    if (!quote || typeof quote !== 'object') {
        return null;
    }

    const value = toNumber(quote['05. price']);
    const changePct = toPercentNumber(quote['10. change percent']);
    if (value === null) {
        return null;
    }

    return {
        value,
        changePct
    };
}

async function fetchStockIndices(warnings) {
    if (!ALPHA_VANTAGE_API_KEY) {
        return null;
    }

    const symbolMap = {
        kospi: '^KS11',
        kosdaq: '^KQ11',
        nasdaq: '^IXIC',
        dow: '^DJI',
        sp500: '^GSPC'
    };
    const fallbackSymbolMap = {
        kospi: 'EWY',
        kosdaq: 'KORU',
        nasdaq: 'QQQ',
        dow: 'DIA',
        sp500: 'SPY'
    };

    const entries = await Promise.all(
        Object.entries(symbolMap).map(async ([key, symbol]) => {
            try {
                let point = await fetchAlphaVantageGlobalQuote(symbol);
                if (!point) {
                    const fallbackSymbol = fallbackSymbolMap[key];
                    if (fallbackSymbol) {
                        point = await fetchAlphaVantageGlobalQuote(fallbackSymbol);
                    }
                }
                return [key, point];
            } catch (error) {
                warnings.push(`ALPHA_VANTAGE ${key} 실패: ${error.message}`);
                return [key, null];
            }
        })
    );

    const defaults = {
        kospi: { value: 2650.2, changePct: 0.65 },
        kosdaq: { value: 865.7, changePct: -0.22 },
        nasdaq: { value: 18145.3, changePct: 0.88 },
        dow: { value: 42035.1, changePct: 0.41 },
        sp500: { value: 5612.4, changePct: 0.52 }
    };

    const result = Object.fromEntries(entries.filter(([, point]) => point !== null));
    if (Object.keys(result).length === 0) {
        warnings.push('주가지수 데이터 없음(기본값 사용)');
        return defaults;
    }

    Object.keys(defaults).forEach((key) => {
        if (!result[key]) {
            result[key] = defaults[key];
            warnings.push(`주가지수 ${key} 기본값 사용`);
        }
    });

    if (Object.keys(result).length !== Object.keys(defaults).length) {
        warnings.push('주가지수 일부만 수신');
    }

    return result;
}

async function buildIndicatorsPayload() {
    const warnings = [];

    if (!FRED_API_KEY) {
        warnings.push('FRED_API_KEY 누락');
    }
    if (!ECOS_API_KEY) {
        warnings.push('ECOS_API_KEY 누락');
    }
    if (!FASTFOREX_API_KEY) {
        warnings.push('FASTFOREX_API 누락');
    }
    if (!ALPHA_VANTAGE_API_KEY) {
        warnings.push('ALPHA_VANTAGE_API_KEY 누락');
    }
    if (!AISSTREAM_API_KEY) {
        warnings.push('AISSTREAM_API_KEY 누락');
    }

    const fedfundsPromise = fetchFredLatest('FEDFUNDS').catch((error) => {
        warnings.push(`FRED FEDFUNDS 실패: ${error.message}`);
        return null;
    });

    const liborPromise = fetchFredLatest('USD3MTD156N')
        .catch(() => null)
        .then(async (value) => {
            if (value !== null) {
                return value;
            }
            // LIBOR series can be sparse/discontinued; fallback for continuity.
            const fallback = await fetchFredLatest('SOFR').catch((error) => {
                warnings.push(`FRED LIBOR/SOFR 실패: ${error.message}`);
                return null;
            });
            if (fallback === null) {
                warnings.push('LIBOR 데이터 없음');
            }
            return fallback;
        });

    const bokPromise = fetchBokBaseRate().catch((error) => {
        warnings.push(`BOK 기준금리 실패: ${error.message}`);
        return null;
    });

    const usdkrwPromise = fetchFastForexUsdKrw()
        .catch((error) => {
            warnings.push(`FASTFOREX USD/KRW 실패: ${error.message}`);
            return null;
        })
        .then(async (value) => {
            if (value !== null) {
                return value;
            }

            const fallback = await fetchFredLatest('DEXKOUS').catch((error) => {
                warnings.push(`FRED DEXKOUS 실패: ${error.message}`);
                return null;
            });
            if (fallback === null) {
                warnings.push('USD/KRW 데이터 없음');
            }
            return fallback;
        });

    const [fedfunds, libor, bok, usdkrw] = await Promise.all([
        fedfundsPromise,
        liborPromise,
        bokPromise,
        usdkrwPromise
    ]);

    const stockIndices = await fetchStockIndices(warnings);

    return {
        fedfunds,
        libor,
        bok,
        usdkrw,
        stockIndices,
        timestamp: new Date().toISOString(),
        warnings
    };
}

async function getIndicators() {
    const now = Date.now();
    if (indicatorCache.payload && indicatorCache.expiresAt > now) {
        return indicatorCache.payload;
    }

    const payload = await buildIndicatorsPayload();
    indicatorCache = {
        payload,
        expiresAt: now + CACHE_TTL_MS
    };
    return payload;
}

const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://localhost');

    if (requestUrl.pathname === '/' || requestUrl.pathname === '/crisis-monitoring-dashboard.html') {
        fs.readFile(DASHBOARD_FILE, 'utf8', (error, html) => {
            if (error) {
                sendJson(res, 500, { error: 'dashboard file read failed' });
                return;
            }
            sendHtml(res, html);
        });
        return;
    }

    if (requestUrl.pathname === '/api/health') {
        sendJson(res, 200, {
            ok: true,
            fredConfigured: Boolean(FRED_API_KEY),
            ecosConfigured: Boolean(ECOS_API_KEY),
            fastforexConfigured: Boolean(FASTFOREX_API_KEY),
            fastforexAccountConfigured: Boolean(FASTFOREX_ACCOUNT),
            alphaVantageConfigured: Boolean(ALPHA_VANTAGE_API_KEY),
            aisstreamConfigured: Boolean(AISSTREAM_API_KEY)
        });
        return;
    }

    if (requestUrl.pathname === '/api/indicators') {
        try {
            const payload = await getIndicators();
            sendJson(res, 200, payload);
        } catch (error) {
            sendJson(res, 500, { error: error.message || 'indicator fetch failed' });
        }
        return;
    }

    if (requestUrl.pathname === '/api/news') {
        try {
            const payload = await getNews();
            sendJson(res, 200, payload);
        } catch (error) {
            sendJson(res, 500, { error: error.message || 'news fetch failed' });
        }
        return;
    }

    sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] http://localhost:${PORT}`);
});
