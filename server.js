const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── .env loader ────────────────────────────────────────────────────────────

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

// ─── Config ─────────────────────────────────────────────────────────────────

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

// Yahoo Finance symbol maps
const YAHOO_INDEX_SYMBOLS = {
    kospi: '%5EKS11',
    kosdaq: '%5EKQ11',
    nasdaq: '%5EIXIC',
    dow: '%5EDJI',
    sp500: '%5EGSPC'
};

const YAHOO_SECTOR_SYMBOLS = {
    kbfin: '105560.KS',
    shinhan: '055550.KS',
    hanafin: '086790.KS',
    hyundaie: '000720.KS',
    daewooec: '047040.KS',
    dlenc: '375500.KS'
};

const YAHOO_COMMODITY_SYMBOLS = {
    wti: 'CL%3DF',
    brent: 'BZ%3DF',
    gas: 'NG%3DF',
    gold: 'GC%3DF'
};

const YAHOO_FX_SYMBOLS = {
    usdkrw: 'USDKRW%3DX'
};

const CACHE_TTL_MS = 60 * 1000;
const NEWS_CACHE_TTL_MS = 3 * 60 * 1000;
const MAX_NEWS_ITEMS = 24;

let indicatorCache = { expiresAt: 0, payload: null };
let newsCache = { expiresAt: 0, payload: null };

// ─── Helpers ────────────────────────────────────────────────────────────────

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
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*'
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
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            Accept: 'application/rss+xml, application/xml, text/xml, */*'
        }
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.text();
}

// ─── Yahoo Finance (FREE, no API key) ───────────────────────────────────────

async function fetchYahooQuote(encodedSymbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?interval=1d&range=5d&includePrePost=false`;
    const data = await fetchJson(url);

    const result = data?.chart?.result?.[0];
    if (!result) {
        return null;
    }

    const meta = result.meta;
    const price = toNumber(meta?.regularMarketPrice);
    const prevClose = toNumber(meta?.chartPreviousClose ?? meta?.previousClose);

    if (price === null) {
        return null;
    }

    let changePct = null;
    if (prevClose !== null && prevClose !== 0) {
        changePct = ((price - prevClose) / prevClose) * 100;
    }

    return { value: price, changePct };
}

async function fetchYahooQuotes(symbolMap, warnings, label) {
    const entries = await Promise.all(
        Object.entries(symbolMap).map(async ([key, symbol]) => {
            try {
                const quote = await fetchYahooQuote(symbol);
                return [key, quote];
            } catch (error) {
                warnings.push(`Yahoo ${label} ${key}: ${error.message}`);
                return [key, null];
            }
        })
    );
    return Object.fromEntries(entries.filter(([, v]) => v !== null));
}

// ─── FRED API (interest rates) ──────────────────────────────────────────────

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

// ─── BOK ECOS (한국 기준금리) ───────────────────────────────────────────────

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

// ─── FastForex (USD/KRW fallback) ───────────────────────────────────────────

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
    return toNumber(data?.result?.KRW) ??
        toNumber(data?.result?.krw) ??
        toNumber(data?.result);
}

// ─── Alpha Vantage (stock indices fallback) ─────────────────────────────────

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

    return { value, changePct };
}

// ─── RSS News ───────────────────────────────────────────────────────────────

function escapeRegExp(input) {
    return String(input).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(text) {
    const named = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
        '&#39;': "'", '&apos;': "'", '&nbsp;': ' '
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
    return extractTagText(itemBlock, ['link', 'guid', 'id']);
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
        .map(([, block]) => ({
            source: sourceName,
            title: extractTagText(block, ['title']),
            link: extractRssLink(block),
            publishedAt: parseDateToIso(extractTagText(block, ['pubDate', 'dc:date', 'updated', 'published'])),
            summary: extractTagText(block, ['description', 'content:encoded', 'summary'], { stripMarkup: true })
        }))
        .filter((item) => item.title && item.link);
}

function parseAtomItems(xml, sourceName) {
    const blocks = [...String(xml).matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
    return blocks
        .map(([, block]) => ({
            source: sourceName,
            title: extractTagText(block, ['title']),
            link: extractAtomLink(block),
            publishedAt: parseDateToIso(extractTagText(block, ['updated', 'published', 'dc:date'])),
            summary: extractTagText(block, ['summary', 'content'], { stripMarkup: true })
        }))
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
        deduped.push({ ...item, publishedAt: item.publishedAt || null });
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
    newsCache = { payload, expiresAt: now + NEWS_CACHE_TTL_MS };
    return payload;
}

// ─── Build indicators payload ───────────────────────────────────────────────

async function buildIndicatorsPayload() {
    const warnings = [];

    // 1) Yahoo Finance — free, no API key needed
    const [yahooIndices, yahooSectors, yahooCommodities, yahooFx] = await Promise.all([
        fetchYahooQuotes(YAHOO_INDEX_SYMBOLS, warnings, '지수').catch(() => ({})),
        fetchYahooQuotes(YAHOO_SECTOR_SYMBOLS, warnings, '섹터주').catch(() => ({})),
        fetchYahooQuotes(YAHOO_COMMODITY_SYMBOLS, warnings, '원자재').catch(() => ({})),
        fetchYahooQuotes(YAHOO_FX_SYMBOLS, warnings, '환율').catch(() => ({}))
    ]);

    // 2) Interest rates from FRED/ECOS (need API keys)
    const fedfundsPromise = fetchFredLatest('FEDFUNDS').catch((error) => {
        warnings.push(`FRED FEDFUNDS: ${error.message}`);
        return null;
    });

    const liborPromise = fetchFredLatest('USD3MTD156N')
        .catch(() => null)
        .then(async (value) => {
            if (value !== null) return value;
            const fallback = await fetchFredLatest('SOFR').catch(() => null);
            if (fallback === null) warnings.push('LIBOR/SOFR 데이터 없음');
            return fallback;
        });

    const bokPromise = fetchBokBaseRate().catch((error) => {
        warnings.push(`BOK 기준금리: ${error.message}`);
        return null;
    });

    const [fedfunds, libor, bok] = await Promise.all([fedfundsPromise, liborPromise, bokPromise]);

    // 3) USD/KRW: Yahoo first, then FastForex, then FRED
    let usdkrw = yahooFx.usdkrw?.value ?? null;
    let usdkrwChangePct = yahooFx.usdkrw?.changePct ?? null;
    if (usdkrw === null) {
        usdkrw = await fetchFastForexUsdKrw().catch(() => null);
        if (usdkrw === null) {
            usdkrw = await fetchFredLatest('DEXKOUS').catch(() => null);
            if (usdkrw === null) warnings.push('USD/KRW 데이터 없음');
        }
    }

    // 4) Stock indices: Yahoo first, then Alpha Vantage fallback
    const stockIndices = { ...yahooIndices };
    const missingIndices = Object.keys(YAHOO_INDEX_SYMBOLS).filter((k) => !stockIndices[k]);

    if (missingIndices.length > 0 && ALPHA_VANTAGE_API_KEY) {
        const avSymbols = { kospi: '^KS11', kosdaq: '^KQ11', nasdaq: '^IXIC', dow: '^DJI', sp500: '^GSPC' };
        await Promise.all(
            missingIndices.map(async (key) => {
                try {
                    const point = await fetchAlphaVantageGlobalQuote(avSymbols[key]);
                    if (point) stockIndices[key] = point;
                } catch (error) {
                    warnings.push(`AlphaVantage ${key}: ${error.message}`);
                }
            })
        );
    }

    // 5) Sector stocks
    const sectorStocks = { ...yahooSectors };

    // 6) Commodities
    const commodities = { ...yahooCommodities };

    // 7) Gold
    const gold = yahooCommodities.gold?.value ?? null;
    const goldChangePct = yahooCommodities.gold?.changePct ?? null;

    // Source tracking
    const sources = [];
    if (Object.keys(yahooIndices).length > 0) sources.push('Yahoo Finance(지수)');
    if (Object.keys(yahooSectors).length > 0) sources.push('Yahoo Finance(섹터주)');
    if (Object.keys(yahooCommodities).length > 0) sources.push('Yahoo Finance(원자재)');
    if (fedfunds !== null) sources.push('FRED');
    if (bok !== null) sources.push('ECOS');
    if (sources.length === 0) sources.push('fallback defaults');

    return {
        // Interest rates
        fedfunds,
        libor,
        bok,
        // FX
        usdkrw,
        usdkrwChangePct,
        // Stock indices
        stockIndices,
        // Sector stocks: { kbfin: {value, changePct}, shinhan: ... }
        sectorStocks,
        // Commodities: { wti: {value, changePct}, brent: ..., gas: ..., gold: ... }
        commodities,
        // Standalone gold for finance card
        gold,
        goldChangePct,
        // Meta
        timestamp: new Date().toISOString(),
        sources,
        warnings
    };
}

async function getIndicators() {
    const now = Date.now();
    if (indicatorCache.payload && indicatorCache.expiresAt > now) {
        return indicatorCache.payload;
    }

    const payload = await buildIndicatorsPayload();
    indicatorCache = { payload, expiresAt: now + CACHE_TTL_MS };
    return payload;
}

// ─── HTTP Server ────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

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
            yahooFinance: true,
            fredConfigured: Boolean(FRED_API_KEY),
            ecosConfigured: Boolean(ECOS_API_KEY),
            fastforexConfigured: Boolean(FASTFOREX_API_KEY),
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
    console.log(`[server] Yahoo Finance: enabled (free, no API key)`);
    console.log(`[server] FRED: ${FRED_API_KEY ? 'configured' : 'not configured'}`);
    console.log(`[server] ECOS: ${ECOS_API_KEY ? 'configured' : 'not configured'}`);
});
