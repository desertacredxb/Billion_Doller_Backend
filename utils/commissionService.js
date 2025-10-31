const axios = require("axios");

// Commission rates per symbol (in USD per lot)
const COMMISSION_RATES = {
  // Forex Majors change to 2.25x dated 31/10/2025
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
  XAUUSD: 6.075,
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
