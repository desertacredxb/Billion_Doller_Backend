const axios = require("axios");

// Commission rates per symbol (in USD per lot)
const COMMISSION_RATES = {
  // Forex Majors
  EURUSD: 2,
  GBPUSD: 2,
  USDJPY: 2,
  USDCHF: 2,
  AUDUSD: 2,
  USDCAD: 2,
  NZDUSD: 2,
  EURGBP: 2,
  EURJPY: 2,
  EURAUD: 2,
  EURCAD: 2,
  EURNZD: 2,
  GBPJPY: 2,
  GBPAUD: 2,
  GBPCAD: 2,
  GBPNZD: 2,
  AUDJPY: 2,
  AUDNZD: 2,
  AUDCAD: 2,
  AUDCHF: 2,
  CADJPY: 2,
  CADCHF: 2,
  NZDJPY: 2,
  NZDCAD: 2,
  NZDCHF: 2,
  CHFJPY: 2,

  // Metals
  XAUUSD: 2.7,
  XAGUSD: 20,

  // Crypto Perpetuals
  BTCUSDPERP: 3,
  ADAUSDPERP: 2,
  BNBUSDPERP: 1,
  ETHUSDPERP: 1,
  SOLUSDPERP: 1,
  SUIUSDPERP: 1,
  XRPUSDPERP: 1,
};

// Broker’s share percentage
const IB_SHARE_PERCENTAGE = 0.33;

/**
 * Calculate commission for a single client
 * @param {string} accountNo
 * @param {string} sdate
 * @param {string} edate
 * @returns {number} total commission for this client
 */
async function calculateClientCommission(accountNo, sdate, edate) {
  try {
    const { data } = await axios.post(
      "https://api.moneyplantfx.com/WSMoneyplant.aspx",
      { accountno: accountNo, sdate, edate },
      {
        params: { type: "SNDPDeal" },
        headers: { "Content-Type": "application/json" },
      }
    );

    if (data.response !== "success" || !Array.isArray(data.data)) return 0;

    let totalCommission = 0;

    for (const trade of data.data) {
      const symbol = trade.Symbol;
      const lots = Number(trade.Qty || 0);
      if (COMMISSION_RATES[symbol]) {
        totalCommission +=
          lots * COMMISSION_RATES[symbol] * IB_SHARE_PERCENTAGE;
      }
    }

    return totalCommission;
  } catch (err) {
    console.error("Error fetching trades:", err.message);
    return 0;
  }
}

module.exports = { calculateClientCommission };
