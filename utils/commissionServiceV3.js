const Deal = require("../models/Deal.model"); // Deal Mongoose model (filled by the MT5 webhook)
const IB = require("../models/Broker.model"); // IB model (registered as "IB")

// Base Commission rates per symbol (in USD per 1.0 Standard Lot)
const COMMISSION_RATES = {
  EURUSD: 4.5,
  GBPUSD: 4.5,
  USDJPY: 4.5,
  USDCHF: 4.5,
  AUDUSD: 4.5,
  USDCAD: 4.5,
  NZDUSD: 4.5,
  EURGBP: 4.5,
  EURJPY: 4.5,
  EURAUD: 4.5,
  EURCAD: 4.5,
  EURNZD: 4.5,
  GBPJPY: 4.5,
  GBPAUD: 4.5,
  GBPCAD: 4.5,
  GBPNZD: 4.5,
  AUDJPY: 4.5,
  AUDNZD: 4.5,
  AUDCAD: 4.5,
  AUDCHF: 4.5,
  CADJPY: 4.5,
  CADCHF: 4.5,
  NZDJPY: 4.5,
  NZDCAD: 4.5,
  NZDCHF: 4.5,
  CHFJPY: 4.5,

  // Metals
  XAUUSD: 12,
  XAGUSD: 45,

  // Crypto Perpetuals
  BTCUSDPERP: 6.75,
  ADAUSDPERP: 4.5,
  BNBUSDPERP: 2.25,
  ETHUSDPERP: 2.25,
  SOLUSDPERP: 2.25,
  SUIUSDPERP: 2.25,
  XRPUSDPERP: 2.25,
};

/**
 * Normalizes raw symbol names (e.g., "XAUUSD.lp" -> "XAUUSD")
 */
function normalizeSymbol(rawSymbol) {
  if (!rawSymbol) return "";
  // Removes suffixes like .lp, .ecn, .pro, etc.
  return rawSymbol.split(".")[0].toUpperCase();
}

/**
 * Calculate commission for a given MT5 account login and time period directly from MongoDB
 * 
 * @param {string} accountNo - MT5 login ID
 * @param {Date|string} sdate - Start date
 * @param {Date|string} edate - End date
 * @param {number} ibSharePercentage - Optional dynamic share override (e.g. 0.33 or from IB model)
 * @returns {Promise<number>} Total calculated commission
 */
async function calculateClientCommission(accountNo, sdate, edate, ibSharePercentage = 0.33) {
  try {
    const startTimestamp = Math.floor(new Date(sdate).getTime() / 1000);
    const endTimestamp = Math.floor(new Date(edate).getTime() / 1000);

    // Fetch closed deals (action: "0" Buy or "1" Sell, entry: "1" Out)
    const deals = await Deal.find({
      login: String(accountNo),
      entry: "1", // Only calculate commission on closed positions (Entry OUT)
      action: { $in: ["0", "1"] }, // Only trade actions
      time: { $gte: String(startTimestamp), $lte: String(endTimestamp) },
    }).lean();

    let totalCommission = 0;

    for (const deal of deals) {
      const cleanSymbol = normalizeSymbol(deal.symbol);
      const rate = COMMISSION_RATES[cleanSymbol];

      if (rate) {
        // Convert raw MT5 volume to Standard Lots (1 Lot = 10,000 units in raw payload)
        const rawVolume = parseFloat(deal.volume || 0);
        const lots = rawVolume / 10000;

        const dealCommission = lots * rate * ibSharePercentage;
        totalCommission += dealCommission;
      }
    }

    return Number(totalCommission.toFixed(2));
  } catch (err) {
    console.error(`Error calculating commission for login ${accountNo}:`, err.message);
    return 0;
  }
}

module.exports = { calculateClientCommission, normalizeSymbol };