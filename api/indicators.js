const { buildIndicatorsPayload } = require('./_lib/shared');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    try {
        const payload = await buildIndicatorsPayload();
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
        res.status(200).json(payload);
    } catch (error) {
        res.status(500).json({ error: error.message || 'indicator fetch failed' });
    }
};
