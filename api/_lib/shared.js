// ─── Shared functions for Vercel Serverless Functions ────────────────────────
// Extracted from server.js — all helpers, constants, fetch functions, parsers

// ─── Config ─────────────────────────────────────────────────────────────────

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
    dlenc: '375500.KS',
    gsenc: '006360.KS',
    poscoenc: '034220.KS',
    cement: '004980.KS'
};

const YAHOO_COMMODITY_SYMBOLS = {
    wti: 'CL%3DF',
    brent: 'BZ%3DF',
    gas: 'NG%3DF',
    gold: 'GC%3DF',
    silver: 'SI%3DF',
    steel: 'HRC%3DF',
    lng: 'NG%3DF'
};

const YAHOO_FX_SYMBOLS = {
    usdkrw: 'USDKRW%3DX'
};

const YAHOO_MACRO_SYMBOLS = {
    vix: '%5EVIX',
    us10y: '%5ETNX',
    us2y: '%5EIRX'
};

const ME_BBOX = { minLat: 10, maxLat: 39, minLon: 32, maxLon: 63 };

const MAX_NEWS_ITEMS = 24;

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

// ─── Translation (Google Translate free endpoint) ───────────────────────────

async function translateToKorean(text) {
    if (!text || text.length === 0) return text;
    if (/[\uAC00-\uD7AF]/.test(text)) return text;
    try {
        const encoded = encodeURIComponent(text.slice(0, 500));
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ko&dt=t&q=${encoded}`;
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        if (!resp.ok) return text;
        const data = await resp.json();
        const translated = (data?.[0] || []).map(s => s?.[0] || '').join('');
        return translated || text;
    } catch {
        return text;
    }
}

async function translateNewsItems(items) {
    const batch = items.slice(0, 24);
    const translated = await Promise.all(
        batch.map(async (item) => {
            const [title, summary] = await Promise.all([
                translateToKorean(item.title),
                translateToKorean(item.summary || '')
            ]);
            return { ...item, title, summary };
        })
    );
    return translated;
}

// ─── Yahoo Finance (FREE, no API key) ───────────────────────────────────────

async function fetchYahooQuote(encodedSymbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?interval=1d&range=1d&includePrePost=false`;
    const data = await fetchJson(url);

    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const meta = result.meta;
    const price = toNumber(meta?.regularMarketPrice);
    const prevClose = toNumber(meta?.previousClose ?? meta?.chartPreviousClose);

    if (price === null) return null;

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
    if (!FRED_API_KEY) return null;

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
        if (parsed !== null) return parsed;
    }
    return null;
}

// ─── BOK ECOS (한국 기준금리) ───────────────────────────────────────────────

async function fetchBokBaseRate() {
    if (!ECOS_API_KEY) return null;

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
    if (!Array.isArray(rows)) return null;

    for (let i = rows.length - 1; i >= 0; i -= 1) {
        const parsed = toNumber(rows[i]?.DATA_VALUE);
        if (parsed !== null) return parsed;
    }
    return null;
}

// ─── ECOS Housing Price Index (주택매매가격지수) ────────────────────────────

async function fetchEcosHousingIndex() {
    if (!ECOS_API_KEY) return null;

    const now = new Date();
    const endYear = now.getFullYear();
    const endMonth = String(now.getMonth() + 1).padStart(2, '0');
    const end = `${endYear}${endMonth}`;
    const start = `${endYear - 2}01`;

    const url =
        `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_API_KEY}/json/kr/1/120/` +
        `901Y009/M/${start}/${end}/H01`;

    const data = await fetchJson(url);
    const rows = data?.StatisticSearch?.row;
    if (!Array.isArray(rows) || rows.length === 0) return null;

    let latest = null, prev = null;
    for (let i = rows.length - 1; i >= 0; i--) {
        const v = toNumber(rows[i]?.DATA_VALUE);
        if (v !== null) {
            if (latest === null) { latest = v; }
            else if (prev === null) { prev = v; break; }
        }
    }
    if (latest === null) return null;
    const changePct = (prev !== null && prev !== 0) ? ((latest - prev) / prev) * 100 : null;
    return { value: latest, changePct };
}

// ─── FastForex (USD/KRW fallback) ───────────────────────────────────────────

async function fetchFastForexUsdKrw() {
    if (!FASTFOREX_API_KEY) return null;

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
    if (!ALPHA_VANTAGE_API_KEY) return null;

    const url = new URL('https://www.alphavantage.co/query');
    url.searchParams.set('function', 'GLOBAL_QUOTE');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('apikey', ALPHA_VANTAGE_API_KEY);

    const data = await fetchJson(url.toString());
    const quote = data?.['Global Quote'];
    if (!quote || typeof quote !== 'object') return null;

    const value = toNumber(quote['05. price']);
    const changePct = toPercentNumber(quote['10. change percent']);
    if (value === null) return null;

    return { value, changePct };
}

// ─── OpenSky Network (FREE aircraft tracking) ──────────────────────────────

async function fetchAircraftOpenSky() {
    const url = `https://opensky-network.org/api/states/all?lamin=${ME_BBOX.minLat}&lomin=${ME_BBOX.minLon}&lamax=${ME_BBOX.maxLat}&lomax=${ME_BBOX.maxLon}`;
    const data = await fetchJson(url);
    const states = Array.isArray(data?.states) ? data.states : [];

    const milCountries = new Set(['United States', 'United Kingdom', 'France', 'Israel', 'Turkey', 'Saudi Arabia', 'Iran']);
    const milCallsignPrefixes = [
        'RCH', 'REACH', 'EVAC', 'DUKE', 'JAKE', 'HOMER', 'FORTE',
        'LAGR', 'NAVY', 'TOPCAT', 'SNTRY', 'IRON', 'RAIDR',
        'SHELL', 'KING', 'ATLAS', 'IAF', 'RSAF', 'UAE', 'QAF',
        'RRR', 'AERO', 'PACK', 'VIPER', 'DOOM', 'BAF',
        'GHOST', 'HYDRA', 'DEATH', 'OMNI', 'TEAL'
    ];
    const milHexPrefixes = ['ae', 'af', '43c', '3f', '738'];

    const results = [];
    for (const s of states) {
        const icao24 = String(s[0] || '').toLowerCase().trim();
        const callsign = String(s[1] || '').trim().toUpperCase();
        const country = String(s[2] || '');
        const lon = toNumber(s[5]);
        const lat = toNumber(s[6]);
        const alt = toNumber(s[7]) || 0;
        const onGround = s[8];
        const speed = toNumber(s[9]) || 0;
        const heading = toNumber(s[10]) || 0;

        if (lat === null || lon === null || onGround) continue;

        const isMilCall = milCallsignPrefixes.some(p => callsign.startsWith(p));
        const isMilHex = milHexPrefixes.some(p => icao24.startsWith(p));
        const isMilCountry = milCountries.has(country) && alt > 5000;

        if (!isMilCall && !isMilHex && !isMilCountry) continue;

        results.push({
            id: icao24,
            callsign: callsign || 'UNKNOWN',
            type: country,
            lat, lon,
            alt: Math.round(alt * 3.281),
            speed: Math.round(speed * 1.944),
            heading,
            category: 'aircraft'
        });
    }
    return results;
}

// ─── Vessel Tracking (Digitraffic AIS) ──────────────────────────────────────

async function fetchVessels() {
    const results = [];

    try {
        const areas = [
            { lat: 26.5, lon: 56.3, label: 'Hormuz' },
            { lat: 13.0, lon: 43.5, label: 'Bab-el-Mandeb' },
            { lat: 24.5, lon: 51.5, label: 'Gulf' }
        ];

        for (const area of areas) {
            try {
                const url = `https://meri.digitraffic.fi/api/ais/v1/locations?latitude=${area.lat}&longitude=${area.lon}&radius=300&from=0`;
                const data = await fetchJson(url);
                const features = data?.features || [];
                for (const f of features.slice(0, 20)) {
                    const props = f.properties || {};
                    const coords = f.geometry?.coordinates || [];
                    const lon = toNumber(coords[0]);
                    const lat = toNumber(coords[1]);
                    if (lat === null || lon === null) continue;
                    if (lat < ME_BBOX.minLat || lat > ME_BBOX.maxLat) continue;
                    if (lon < ME_BBOX.minLon || lon > ME_BBOX.maxLon) continue;

                    results.push({
                        id: String(props.mmsi || `v-${lat.toFixed(2)}-${lon.toFixed(2)}`),
                        name: String(props.name || 'VESSEL').trim(),
                        mmsi: String(props.mmsi || ''),
                        type: String(props.shipType || 'cargo'),
                        lat, lon,
                        speed: toNumber(props.sog) || 0,
                        heading: toNumber(props.cog) || 0,
                        category: 'vessel'
                    });
                }
            } catch {
                // Individual area query failed
            }
        }
    } catch {
        // Digitraffic unavailable
    }

    const seen = new Set();
    return results.filter(v => {
        if (seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
    });
}

// ─── Conflict Events (News-based extraction) ────────────────────────────────

const CONFLICT_LOCATIONS = {
    'gaza': { lat: 31.35, lon: 34.31, country: 'Palestine' },
    'rafah': { lat: 31.27, lon: 34.25, country: 'Palestine' },
    'khan younis': { lat: 31.34, lon: 34.30, country: 'Palestine' },
    'beirut': { lat: 33.89, lon: 35.50, country: 'Lebanon' },
    'south lebanon': { lat: 33.27, lon: 35.20, country: 'Lebanon' },
    'damascus': { lat: 33.51, lon: 36.28, country: 'Syria' },
    'aleppo': { lat: 36.20, lon: 37.15, country: 'Syria' },
    'idlib': { lat: 35.93, lon: 36.63, country: 'Syria' },
    'baghdad': { lat: 33.32, lon: 44.37, country: 'Iraq' },
    'mosul': { lat: 36.34, lon: 43.14, country: 'Iraq' },
    'tehran': { lat: 35.69, lon: 51.39, country: 'Iran' },
    'isfahan': { lat: 32.65, lon: 51.67, country: 'Iran' },
    'sanaa': { lat: 15.37, lon: 44.19, country: 'Yemen' },
    'aden': { lat: 12.79, lon: 45.02, country: 'Yemen' },
    'hodeidah': { lat: 14.80, lon: 42.95, country: 'Yemen' },
    'marib': { lat: 15.46, lon: 45.32, country: 'Yemen' },
    'hormuz': { lat: 26.57, lon: 56.25, country: 'Iran' },
    'red sea': { lat: 15.50, lon: 41.00, country: 'Yemen' },
    'tel aviv': { lat: 32.08, lon: 34.78, country: 'Israel' },
    'west bank': { lat: 31.95, lon: 35.20, country: 'Palestine' },
    'houthi': { lat: 15.37, lon: 44.19, country: 'Yemen' }
};

const CONFLICT_KEYWORDS = ['attack', 'strike', 'airstrike', 'missile', 'bomb', 'kill',
    'military', 'soldier', 'combat', 'war', 'conflict', 'explosion', 'shell',
    'drone', 'raid', 'offensive', 'ceasefire', 'truce', 'houthi', 'hezbollah',
    'hamas', 'idf', 'irgc', 'militia', 'insurgent', 'casualt'];

async function fetchConflictFromNews(newsPayload) {
    try {
        const items = newsPayload?.items || [];
        const results = [];

        for (const item of items) {
            const text = `${item.title} ${item.summary}`.toLowerCase();
            const hasConflictKeyword = CONFLICT_KEYWORDS.some(kw => text.includes(kw));
            if (!hasConflictKeyword) continue;

            for (const [locName, locData] of Object.entries(CONFLICT_LOCATIONS)) {
                if (text.includes(locName)) {
                    results.push({
                        date: item.publishedAt ? item.publishedAt.split('T')[0] : new Date().toISOString().split('T')[0],
                        type: text.includes('airstrike') || text.includes('missile') ? 'Airstrike/Missile' :
                              text.includes('drone') ? 'Drone Attack' :
                              text.includes('bomb') || text.includes('explosion') ? 'Explosion' : 'Armed Conflict',
                        subType: item.source || '',
                        country: locData.country,
                        location: locName.charAt(0).toUpperCase() + locName.slice(1),
                        lat: locData.lat + (Math.random() - 0.5) * 0.1,
                        lon: locData.lon + (Math.random() - 0.5) * 0.1,
                        fatalities: 0,
                        notes: item.title.slice(0, 200),
                        category: 'conflict'
                    });
                    break;
                }
            }
        }

        return results;
    } catch {
        return [];
    }
}

// ─── GDELT (global event monitoring) ────────────────────────────────────────

async function fetchGDELTEvents() {
    try {
        const query = encodeURIComponent('(Iran OR Iraq OR Syria OR Yemen OR "Strait of Hormuz") (military OR airstrike OR missile)');
        const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&maxrecords=20&format=json&timespan=3d`;
        const data = await fetchJson(url);
        const articles = Array.isArray(data?.articles) ? data.articles : [];

        return articles.map(a => ({
            title: a.title || '',
            url: a.url || '',
            source: a.domain || '',
            date: a.seendate || '',
            tone: toNumber(a.tone) || 0,
            category: 'news_event'
        })).slice(0, 15);
    } catch {
        return [];
    }
}

// ─── RSS Parsing ────────────────────────────────────────────────────────────

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
    if (attrMatch?.[1]) return cleanXmlText(attrMatch[1]);
    return extractTagText(itemBlock, ['link', 'guid', 'id']);
}

function extractAtomLink(entryBlock) {
    const alternate = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryBlock);
    if (alternate?.[1]) return cleanXmlText(alternate[1]);

    const href = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/i.exec(entryBlock);
    if (href?.[1]) return cleanXmlText(href[1]);

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
            title: 'RSS 뉴스 피드를 가져올 수 없습니다.',
            link: '',
            summary: '인터넷 연결 상태를 확인해 주세요.',
            publishedAt: new Date(now).toISOString()
        },
        {
            source: 'System',
            title: '서버를 인터넷이 연결된 환경에서 실행해 주세요.',
            link: '',
            summary: 'Reuters, BBC, NYT, Bloomberg 등 6개 소스에서 뉴스를 수집합니다.',
            publishedAt: new Date(now - 5 * 60 * 1000).toISOString()
        }
    ];
}

// ─── Build Payload Functions ────────────────────────────────────────────────

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
        if (seen.has(key)) return;
        seen.add(key);
        deduped.push({ ...item, publishedAt: item.publishedAt || null });
    });

    deduped.sort((a, b) => {
        const left = a.publishedAt ? Date.parse(a.publishedAt) : 0;
        const right = b.publishedAt ? Date.parse(b.publishedAt) : 0;
        return right - left;
    });

    let items = deduped.slice(0, MAX_NEWS_ITEMS);
    if (items.length === 0) {
        warnings.push('no live news items');
        items = getFallbackNewsItems();
    }

    try {
        items = await translateNewsItems(items);
    } catch (err) {
        warnings.push(`번역 실패: ${err.message}`);
    }

    return {
        items,
        timestamp: new Date().toISOString(),
        warnings
    };
}

async function buildIndicatorsPayload() {
    const warnings = [];

    const [yahooIndices, yahooSectors, yahooCommodities, yahooFx, yahooMacro] = await Promise.all([
        fetchYahooQuotes(YAHOO_INDEX_SYMBOLS, warnings, '지수').catch(() => ({})),
        fetchYahooQuotes(YAHOO_SECTOR_SYMBOLS, warnings, '섹터주').catch(() => ({})),
        fetchYahooQuotes(YAHOO_COMMODITY_SYMBOLS, warnings, '원자재').catch(() => ({})),
        fetchYahooQuotes(YAHOO_FX_SYMBOLS, warnings, '환율').catch(() => ({})),
        fetchYahooQuotes(YAHOO_MACRO_SYMBOLS, warnings, '매크로').catch(() => ({}))
    ]);

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

    let usdkrw = yahooFx.usdkrw?.value ?? null;
    let usdkrwChangePct = yahooFx.usdkrw?.changePct ?? null;
    if (usdkrw === null) {
        usdkrw = await fetchFastForexUsdKrw().catch(() => null);
        if (usdkrw === null) {
            usdkrw = await fetchFredLatest('DEXKOUS').catch(() => null);
            if (usdkrw === null) warnings.push('USD/KRW 데이터 없음');
        }
    }

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

    const sectorStocks = { ...yahooSectors };

    // Compute construction stock average (5 companies)
    const constKeys = ['hyundaie', 'daewooec', 'dlenc', 'gsenc', 'poscoenc'];
    const validConst = constKeys.filter(k => sectorStocks[k] && Number.isFinite(sectorStocks[k].value));
    if (validConst.length > 0) {
        const avgValue = validConst.reduce((s, k) => s + sectorStocks[k].value, 0) / validConst.length;
        const avgChangePct = validConst.reduce((s, k) => s + (sectorStocks[k].changePct || 0), 0) / validConst.length;
        sectorStocks.constructionAvg = { value: Math.round(avgValue), changePct: Math.round(avgChangePct * 100) / 100 };
    }

    const commodities = { ...yahooCommodities };

    // JCC-linked LNG price: LNG($/MMBtu) = 0.1485 × Brent($/bbl) + 0.5
    if (commodities.brent && Number.isFinite(commodities.brent.value)) {
        const jccLng = 0.1485 * commodities.brent.value + 0.5;
        const prevBrent = commodities.brent.value / (1 + (commodities.brent.changePct || 0) / 100);
        const prevJccLng = 0.1485 * prevBrent + 0.5;
        const jccChangePct = prevJccLng > 0 ? ((jccLng / prevJccLng) - 1) * 100 : 0;
        commodities.lng = { value: Math.round(jccLng * 100) / 100, changePct: Math.round(jccChangePct * 100) / 100 };
    }

    const gold = yahooCommodities.gold?.value ?? null;
    const goldChangePct = yahooCommodities.gold?.changePct ?? null;

    const reindex = await fetchEcosHousingIndex().catch((err) => {
        warnings.push(`부동산지수: ${err.message}`);
        return null;
    });

    const constructionIndex = null;

    const sources = [];
    if (Object.keys(yahooIndices).length > 0) sources.push('Yahoo Finance(지수)');
    if (Object.keys(yahooSectors).length > 0) sources.push('Yahoo Finance(섹터주)');
    if (Object.keys(yahooCommodities).length > 0) sources.push('Yahoo Finance(원자재)');
    if (fedfunds !== null) sources.push('FRED');
    if (bok !== null) sources.push('ECOS');
    if (reindex !== null) sources.push('ECOS(부동산)');
    if (sources.length === 0) sources.push('fallback defaults');

    // Macro indicators (VIX, Treasury yields)
    const macroIndicators = { ...yahooMacro };

    return {
        fedfunds, libor, bok,
        usdkrw, usdkrwChangePct,
        stockIndices,
        sectorStocks,
        commodities,
        macroIndicators,
        gold, goldChangePct,
        reindex,
        constructionIndex,
        timestamp: new Date().toISOString(),
        sources,
        warnings
    };
}

async function buildMilitaryPayload() {
    const warnings = [];

    // Fetch news first (needed for conflict extraction)
    const newsPayload = await buildNewsPayload().catch(err => {
        warnings.push(`News for conflict: ${err.message}`);
        return { items: [] };
    });

    const [aircraft, vessels, conflicts, gdeltEvents] = await Promise.all([
        fetchAircraftOpenSky().catch(err => { warnings.push(`OpenSky: ${err.message}`); return []; }),
        fetchVessels().catch(err => { warnings.push(`AIS: ${err.message}`); return []; }),
        fetchConflictFromNews(newsPayload).catch(err => { warnings.push(`Conflict: ${err.message}`); return []; }),
        fetchGDELTEvents().catch(err => { warnings.push(`GDELT: ${err.message}`); return []; })
    ]);

    return {
        aircraft,
        vessels,
        conflicts,
        gdeltEvents,
        counts: {
            aircraft: aircraft.length,
            vessels: vessels.length,
            conflicts: conflicts.length,
            gdeltEvents: gdeltEvents.length
        },
        timestamp: new Date().toISOString(),
        sources: [
            aircraft.length > 0 ? 'OpenSky Network' : null,
            vessels.length > 0 ? 'Digitraffic AIS' : null,
            conflicts.length > 0 ? 'RSS-Conflict' : null,
            gdeltEvents.length > 0 ? 'GDELT' : null
        ].filter(Boolean),
        warnings
    };
}

// ─── Yahoo Finance Historical (5Y monthly) ─────────────────────────────────

async function fetchYahooMonthly(encodedSymbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?interval=1mo&range=5y&includePrePost=false`;
    const data = await fetchJson(url);
    const result = data?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const points = [];
    for (let i = 0; i < timestamps.length; i++) {
        const val = toNumber(closes[i]);
        if (val === null) continue;
        const d = new Date(timestamps[i] * 1000);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        points.push({ month, value: val });
    }
    return points;
}

async function fetchFredMonthly(seriesId) {
    if (!FRED_API_KEY) return null;
    const now = new Date();
    const endDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const startYear = now.getFullYear() - 5;
    const startDate = `${startYear}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const url = new URL('https://api.stlouisfed.org/fred/series/observations');
    url.searchParams.set('series_id', seriesId);
    url.searchParams.set('api_key', FRED_API_KEY);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('frequency', 'm');
    url.searchParams.set('observation_start', startDate);
    url.searchParams.set('observation_end', endDate);

    const data = await fetchJson(url.toString());
    const rows = Array.isArray(data.observations) ? data.observations : [];
    const points = [];
    for (const row of rows) {
        const val = toNumber(row.value);
        if (val === null) continue;
        const d = new Date(row.date);
        const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        points.push({ month, value: val });
    }
    return points;
}

function pearsonCorrelation(x, y) {
    const n = x.length;
    if (n < 3) return null;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX, dy = y[i] - meanY;
        num += dx * dy;
        denX += dx * dx;
        denY += dy * dy;
    }
    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
}

async function buildCorrelationPayload() {
    const warnings = [];
    const keys = ['wti', 'brent', 'gold', 'fedfunds', 'usdkrw', 'construction', 'realestate', 'vix', 'us10y'];
    const labels = ['WTI', 'Brent', '금', '기준금리', '환율', '건설주', '부동산', 'VIX', '10Y'];

    // Fetch all 5 construction stocks for averaging
    const constructionTickers = {
        hyundaie: '000720.KS', daewooec: '047040.KS', dlenc: '375500.KS',
        gsenc: '006360.KS', poscoenc: '034220.KS'
    };
    const constructionPromises = Object.entries(constructionTickers).map(async ([name, ticker]) => {
        try { return await fetchYahooMonthly(ticker); }
        catch (e) { warnings.push(`${name} 5Y: ${e.message}`); return null; }
    });

    const seriesPromises = {
        wti: fetchYahooMonthly('CL%3DF').catch(e => { warnings.push(`WTI 5Y: ${e.message}`); return null; }),
        brent: fetchYahooMonthly('BZ%3DF').catch(e => { warnings.push(`Brent 5Y: ${e.message}`); return null; }),
        gold: fetchYahooMonthly('GC%3DF').catch(e => { warnings.push(`Gold 5Y: ${e.message}`); return null; }),
        fedfunds: fetchFredMonthly('FEDFUNDS').catch(e => { warnings.push(`FEDFUNDS 5Y: ${e.message}`); return null; }),
        usdkrw: fetchYahooMonthly('USDKRW%3DX').catch(e => { warnings.push(`USDKRW 5Y: ${e.message}`); return null; }),
        constructionStocks: Promise.all(constructionPromises),
        realestate: fetchYahooMonthly('105560.KS').catch(e => { warnings.push(`KB금융 5Y: ${e.message}`); return null; }),
        vix: fetchYahooMonthly('%5EVIX').catch(e => { warnings.push(`VIX 5Y: ${e.message}`); return null; }),
        us10y: fetchYahooMonthly('%5ETNX').catch(e => { warnings.push(`US10Y 5Y: ${e.message}`); return null; })
    };

    const raw = {};
    const entries = await Promise.all(
        Object.entries(seriesPromises).map(async ([k, p]) => [k, await p])
    );
    for (const [k, v] of entries) raw[k] = v;

    // Average construction stocks into a single "construction" series
    const stocksData = raw.constructionStocks || [];
    const validStocks = stocksData.filter(s => s && s.length > 0);
    if (validStocks.length > 0) {
        // Find common months across all valid construction stocks
        const stockMonthSets = validStocks.map(s => new Set(s.map(p => p.month)));
        let stockCommon = [...stockMonthSets[0]];
        for (let i = 1; i < stockMonthSets.length; i++) {
            stockCommon = stockCommon.filter(m => stockMonthSets[i].has(m));
        }
        stockCommon.sort();
        // Normalize each stock to base 100, then average
        const normalized = validStocks.map(stock => {
            const byM = {}; for (const p of stock) byM[p.month] = p.value;
            const vals = stockCommon.map(m => byM[m]);
            const base = vals[0] || 1;
            return vals.map(v => (v / base) * 100);
        });
        raw.construction = stockCommon.map((month, i) => ({
            month,
            value: normalized.reduce((sum, norm) => sum + norm[i], 0) / normalized.length
        }));
    } else {
        raw.construction = null;
    }
    delete raw.constructionStocks;

    // Build month-aligned intersection
    const monthSets = keys.map(k => new Set((raw[k] || []).map(p => p.month)));
    let commonMonths = [...monthSets[0]];
    for (let i = 1; i < monthSets.length; i++) {
        commonMonths = commonMonths.filter(m => monthSets[i].has(m));
    }
    commonMonths.sort();

    // Build aligned arrays
    const aligned = {};
    for (const k of keys) {
        const byMonth = {};
        for (const p of (raw[k] || [])) byMonth[p.month] = p.value;
        aligned[k] = commonMonths.map(m => byMonth[m]);
    }

    // Compute correlation matrix
    const matrix = [];
    for (let i = 0; i < keys.length; i++) {
        const row = [];
        for (let j = 0; j < keys.length; j++) {
            if (i === j) { row.push(1.0); continue; }
            const r = pearsonCorrelation(aligned[keys[i]], aligned[keys[j]]);
            row.push(r !== null ? Math.round(r * 100) / 100 : null);
        }
        matrix.push(row);
    }

    return {
        keys,
        labels,
        matrix,
        months: commonMonths,
        history: aligned,
        dataPoints: commonMonths.length,
        timestamp: new Date().toISOString(),
        warnings
    };
}

// ─── ECOS Monthly (5Y) ──────────────────────────────────────────────────────

async function fetchEcosMonthly(seriesId, itemCode) {
    if (!ECOS_API_KEY) return null;
    const now = new Date();
    const endYear = now.getFullYear();
    const endMonth = String(now.getMonth() + 1).padStart(2, '0');
    const end = `${endYear}${endMonth}`;
    const start = `${endYear - 5}01`;
    const url =
        `https://ecos.bok.or.kr/api/StatisticSearch/${ECOS_API_KEY}/json/kr/1/600/` +
        `${seriesId}/M/${start}/${end}/${itemCode}`;
    const data = await fetchJson(url);
    const rows = data?.StatisticSearch?.row;
    if (!Array.isArray(rows)) return null;
    const points = [];
    for (const row of rows) {
        const val = toNumber(row?.DATA_VALUE);
        if (val === null) continue;
        const t = String(row.TIME || '');
        const month = t.length >= 6 ? `${t.slice(0, 4)}-${t.slice(4, 6)}` : null;
        if (month) points.push({ month, value: val });
    }
    return points;
}

// ─── Build 5Y History for ALL indicators ─────────────────────────────────────

async function buildHistoryPayload() {
    const warnings = [];
    const safe = (p, label) => p.catch(e => { warnings.push(`${label}: ${e.message}`); return null; });

    // Construction stocks for averaging
    const constTickers = {
        hyundaie: '000720.KS', daewooec: '047040.KS', dlenc: '375500.KS',
        gsenc: '006360.KS', poscoenc: '034220.KS'
    };

    // Fetch all in parallel
    const [
        wti, brent, gas, gold, silver, steel,
        fedfunds, libor, sofr,
        usdkrw,
        kospi, kosdaq, nasdaq, sp500, dow,
        vix, us10y, us2y,
        realestate,
        bok, housingIdx,
        // ECOS Korean indicators
        ppi, importPrice, constructionCostIdx, laborIdx,
        // Cement proxy (쌍용C&E stock)
        cementProxy,
        ...constStocks
    ] = await Promise.all([
        // Commodities
        safe(fetchYahooMonthly('CL%3DF'), 'WTI'),
        safe(fetchYahooMonthly('BZ%3DF'), 'Brent'),
        safe(fetchYahooMonthly('NG%3DF'), 'NatGas'),
        safe(fetchYahooMonthly('GC%3DF'), 'Gold'),
        safe(fetchYahooMonthly('SI%3DF'), 'Silver'),
        safe(fetchYahooMonthly('HRC%3DF'), 'Steel'),
        // Rates
        safe(fetchFredMonthly('FEDFUNDS'), 'FedFunds'),
        safe(fetchFredMonthly('USD3MTD156N'), 'LIBOR'),
        safe(fetchFredMonthly('SOFR'), 'SOFR'),
        // FX
        safe(fetchYahooMonthly('USDKRW%3DX'), 'USD/KRW'),
        // Indices
        safe(fetchYahooMonthly('%5EKS11'), 'KOSPI'),
        safe(fetchYahooMonthly('%5EKQ11'), 'KOSDAQ'),
        safe(fetchYahooMonthly('%5EIXIC'), 'NASDAQ'),
        safe(fetchYahooMonthly('%5EGSPC'), 'S&P500'),
        safe(fetchYahooMonthly('%5EDJI'), 'DOW'),
        // Macro
        safe(fetchYahooMonthly('%5EVIX'), 'VIX'),
        safe(fetchYahooMonthly('%5ETNX'), 'US10Y'),
        safe(fetchYahooMonthly('%5EIRX'), 'US2Y'),
        // Real estate
        safe(fetchYahooMonthly('105560.KS'), 'KB금융'),
        // ECOS
        safe(fetchEcosMonthly('722Y001', '0101000'), 'BOK기준금리'),
        safe(fetchEcosMonthly('901Y009', 'H01'), '주택매매가격'),
        // ECOS — Korean macro indicators
        safe(fetchEcosMonthly('404Y014', 'AA00'), '생산자물가(총지수)'),
        safe(fetchEcosMonthly('401Y015', '*AA'), '수입물가(총지수)'),
        safe(fetchEcosMonthly('901Y062', 'I16AA'), '건설공사비지수'),
        safe(fetchEcosMonthly('901Y062', 'I16BA'), '건설노임지수'),
        // Cement price proxy (쌍용C&E 004980.KS)
        safe(fetchYahooMonthly('004980.KS'), '쌍용C&E'),
        // Construction stocks (individual)
        ...Object.entries(constTickers).map(([name, ticker]) =>
            safe(fetchYahooMonthly(ticker), name)
        )
    ]);

    // Build construction average (normalized base 100)
    const validConst = constStocks.filter(s => s && s.length > 0);
    let constructionAvg = null;
    if (validConst.length > 0) {
        const monthSets = validConst.map(s => new Set(s.map(p => p.month)));
        let common = [...monthSets[0]];
        for (let i = 1; i < monthSets.length; i++) common = common.filter(m => monthSets[i].has(m));
        common.sort();
        const norm = validConst.map(stock => {
            const byM = {}; for (const p of stock) byM[p.month] = p.value;
            const vals = common.map(m => byM[m]);
            const base = vals[0] || 1;
            return vals.map(v => (v / base) * 100);
        });
        constructionAvg = common.map((month, i) => ({
            month, value: Math.round(norm.reduce((s, n) => s + n[i], 0) / norm.length * 100) / 100
        }));
    }

    // LNG from Brent (JCC formula)
    const lng = brent ? brent.map(p => ({
        month: p.month,
        value: Math.round((0.1485 * p.value + 0.5) * 100) / 100
    })) : null;

    const series = {
        wti, brent, gas, lng, gold, silver, steel,
        fedfunds, libor, sofr, bok,
        usdkrw,
        kospi, kosdaq, nasdaq, sp500, dow,
        vix, us10y, us2y,
        realestate, housingIdx,
        ppi, importPrice, constructionCostIdx, laborIdx,
        cementProxy,
        constructionAvg
    };

    // Add individual construction stocks
    const constNames = Object.keys(constTickers);
    constNames.forEach((name, i) => { series[name] = constStocks[i]; });

    // Filter out nulls
    const result = {};
    for (const [k, v] of Object.entries(series)) {
        if (v && v.length > 0) result[k] = v;
    }

    return { series: result, timestamp: new Date().toISOString(), warnings };
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
    ECOS_API_KEY,
    FRED_API_KEY,
    FASTFOREX_API_KEY,
    ALPHA_VANTAGE_API_KEY,
    AISSTREAM_API_KEY,
    buildIndicatorsPayload,
    buildNewsPayload,
    buildMilitaryPayload,
    buildCorrelationPayload,
    buildHistoryPayload
};
