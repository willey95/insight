const {
    ECOS_API_KEY,
    FRED_API_KEY,
    FASTFOREX_API_KEY,
    ALPHA_VANTAGE_API_KEY,
    AISSTREAM_API_KEY
} = require('./_lib/shared');

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    res.status(200).json({
        ok: true,
        yahooFinance: true,
        fredConfigured: Boolean(FRED_API_KEY),
        ecosConfigured: Boolean(ECOS_API_KEY),
        fastforexConfigured: Boolean(FASTFOREX_API_KEY),
        alphaVantageConfigured: Boolean(ALPHA_VANTAGE_API_KEY),
        aisstreamConfigured: Boolean(AISSTREAM_API_KEY)
    });
};
