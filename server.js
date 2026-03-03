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

// Middle East bounding box for military data queries
const ME_BBOX = { minLat: 10, maxLat: 39, minLon: 32, maxLon: 63 };

const CACHE_TTL_MS = 60 * 1000;
const NEWS_CACHE_TTL_MS = 3 * 60 * 1000;
const MILITARY_CACHE_TTL_MS = 30 * 1000;
const MAX_NEWS_ITEMS = 24;

let indicatorCache = { expiresAt: 0, payload: null };
let newsCache = { expiresAt: 0, payload: null };
let militaryCache = { expiresAt: 0, payload: null };

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

// ─── OpenSky Network (FREE aircraft tracking) ──────────────────────────────

async function fetchAircraftOpenSky() {
    // OpenSky REST API — free, no key, returns all aircraft in bounding box
    // state vector: [icao24, callsign, origin_country, time_position, last_contact,
    //   longitude, latitude, baro_altitude, on_ground, velocity, true_track,
    //   vertical_rate, sensors, geo_altitude, squawk, spi, position_source]
    const url = `https://opensky-network.org/api/states/all?lamin=${ME_BBOX.minLat}&lomin=${ME_BBOX.minLon}&lamax=${ME_BBOX.maxLat}&lomax=${ME_BBOX.maxLon}`;
    const data = await fetchJson(url);
    const states = Array.isArray(data?.states) ? data.states : [];

    // Military origin countries and callsign patterns
    const milCountries = new Set(['United States', 'United Kingdom', 'France', 'Israel', 'Turkey', 'Saudi Arabia', 'Iran']);
    const milCallsignPrefixes = [
        'RCH', 'REACH', 'EVAC', 'DUKE', 'JAKE', 'HOMER', 'FORTE',
        'LAGR', 'NAVY', 'TOPCAT', 'SNTRY', 'IRON', 'RAIDR',
        'SHELL', 'KING', 'ATLAS', 'IAF', 'RSAF', 'UAE', 'QAF',
        'RRR', 'AERO', 'PACK', 'VIPER', 'DOOM', 'BAF',
        'GHOST', 'HYDRA', 'DEATH', 'OMNI', 'TEAL'
    ];
    const milHexPrefixes = ['ae', 'af', '43c', '3f', '738'];  // US, FR, IL mil hex ranges

    const results = [];
    for (const s of states) {
        const icao24 = String(s[0] || '').toLowerCase().trim();
        const callsign = String(s[1] || '').trim().toUpperCase();
        const country = String(s[2] || '');
        const lon = toNumber(s[5]);
        const lat = toNumber(s[6]);
        const alt = toNumber(s[7]) || 0;  // meters
        const onGround = s[8];
        const speed = toNumber(s[9]) || 0;  // m/s
        const heading = toNumber(s[10]) || 0;

        if (lat === null || lon === null || onGround) continue;

        const isMilCall = milCallsignPrefixes.some(p => callsign.startsWith(p));
        const isMilHex = milHexPrefixes.some(p => icao24.startsWith(p));
        const isMilCountry = milCountries.has(country) && alt > 5000;  // high-alt mil country aircraft

        if (!isMilCall && !isMilHex && !isMilCountry) continue;

        results.push({
            id: icao24,
            callsign: callsign || 'UNKNOWN',
            type: country,
            lat, lon,
            alt: Math.round(alt * 3.281),  // meters to feet
            speed: Math.round(speed * 1.944),  // m/s to knots
            heading,
            category: 'aircraft'
        });
    }
    return results;
}

// ─── Vessel Tracking (multiple free sources) ────────────────────────────────

async function fetchVessels() {
    const results = [];

    // Source 1: Digitraffic AIS — Finnish maritime authority, free, global coverage
    try {
        // Persian Gulf / Hormuz area
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

    // Deduplicate by MMSI
    const seen = new Set();
    return results.filter(v => {
        if (seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
    });
}

// ─── Conflict Events (News-based extraction from RSS feeds) ─────────────────

// Known conflict locations in the Middle East with approximate coordinates
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

async function fetchConflictFromNews() {
    // Parse already-fetched news for conflict events with location matching
    try {
        const newsPayload = await getNews();
        const items = newsPayload.items || [];
        const results = [];

        for (const item of items) {
            const text = `${item.title} ${item.summary}`.toLowerCase();
            const hasConflictKeyword = CONFLICT_KEYWORDS.some(kw => text.includes(kw));
            if (!hasConflictKeyword) continue;

            // Find location match
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
                    break;  // One location per news item
                }
            }
        }

        return results;
    } catch {
        return [];
    }
}

// ─── GDELT (global event monitoring supplement) ─────────────────────────────

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

// ─── Military Data Aggregator ───────────────────────────────────────────────

async function buildMilitaryPayload() {
    const warnings = [];

    const [aircraft, vessels, conflicts, gdeltEvents] = await Promise.all([
        fetchAircraftOpenSky().catch(err => { warnings.push(`OpenSky: ${err.message}`); return []; }),
        fetchVessels().catch(err => { warnings.push(`AIS: ${err.message}`); return []; }),
        fetchConflictFromNews().catch(err => { warnings.push(`Conflict: ${err.message}`); return []; }),
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

async function getMilitaryData() {
    const now = Date.now();
    if (militaryCache.payload && militaryCache.expiresAt > now) {
        return militaryCache.payload;
    }

    const payload = await buildMilitaryPayload();
    militaryCache = { payload, expiresAt: now + MILITARY_CACHE_TTL_MS };
    return payload;
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

    if (requestUrl.pathname === '/api/military') {
        try {
            const payload = await getMilitaryData();
            sendJson(res, 200, payload);
        } catch (error) {
            sendJson(res, 500, { error: error.message || 'military data fetch failed' });
        }
        return;
    }

    sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] http://localhost:${PORT}`);
    console.log(`[server] Yahoo Finance: enabled (free, no API key)`);
    console.log(`[server] OpenSky Network: enabled (free, aircraft tracking)`);
    console.log(`[server] Conflict: RSS-based event extraction`);
    console.log(`[server] GDELT: enabled (free, event monitoring)`);
    console.log(`[server] AISStream: ${AISSTREAM_API_KEY ? 'configured' : 'not configured'}`);
    console.log(`[server] FRED: ${FRED_API_KEY ? 'configured' : 'not configured'}`);
    console.log(`[server] ECOS: ${ECOS_API_KEY ? 'configured' : 'not configured'}`);
});
