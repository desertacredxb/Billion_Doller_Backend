// MT5-based IB commission calculation (v2).
//
// Companion to utils/commissionService.js (the original MoneyPlant-based
// version), which is left completely untouched so both can be compared
// side by side. This file is the MT5 equivalent, built from what was
// confirmed live against the real server this session:
//   - Volume scale: lots = Number(deal.Volume) / 10000 (confirmed both from
//     the MT5 SDK's MTAPI_VOLUME_DIV constant and the official user guide).
//   - A completed round-turn trade = Action 0 (BUY) or 1 (SELL), with
//     Entry === 1 marking the closing leg - counting only closes avoids
//     double-counting the open+close pair of one trade.
//   - Symbol names carry a broker/group-specific suffix (e.g. "XAUUSD.lp")
//     not present in COMMISSION_RATES' keys - normalizeSymbol() strips
//     everything from the first "." onward before the rate-table lookup.
//   - MT5 does NOT compute this commission itself on this server (every
//     real trade sampled had Commission: "0.00" and Fee: "0.00"), so the
//     rate-table math below is still necessary, same as v1.
//
// NOT wired into ibController.updateIBCommission or User.commission - see
// controllers/ibController.js's updateIBCommissionV2, which reports a
// total without persisting it, for side-by-side comparison against v1.

const { getMT5Deals } = require("./MT5/mt5Deals");

// Same table and values as utils/commissionService.js (USD per lot).
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

// Broker's share percentage
const IB_SHARE_PERCENTAGE = 0.33;

// EnDealAction values that represent a real trade (not balance/credit/
// charge/agent-commission/etc entries mixed into the same deal history).
const DEAL_ACTION_BUY = 0;
const DEAL_ACTION_SELL = 1;

// EnEntryFlags: only count the closing leg of a round-turn, so an open+
// close pair isn't counted twice.
const DEAL_ENTRY_OUT = 1;

const VOLUME_DIV = 10000; // MTAPI_VOLUME_DIV, confirmed against the SDK

/**
 * Strip a broker/group-specific symbol suffix (e.g. "XAUUSD.lp" -> "XAUUSD")
 * before a COMMISSION_RATES lookup. Generic - doesn't hardcode any specific
 * suffix, so it keeps working if the account group's naming convention
 * changes later.
 */
function normalizeSymbol(rawSymbol) {
  if (!rawSymbol) return rawSymbol;
  const dotIndex = rawSymbol.indexOf(".");
  return dotIndex === -1 ? rawSymbol : rawSymbol.slice(0, dotIndex);
}

/**
 * Accept a normal date/time input (ISO string, "YYYY-MM-DD", or a raw unix
 * timestamp) and convert it to unix seconds - the format MT5's deal-history
 * commands expect. Same behavior as mt5Controller.js's parseToUnixSeconds,
 * duplicated here to keep this module dependency-free of the controller
 * layer.
 */
function parseToUnixSeconds(value, paramName) {
  const asDate = new Date(value);
  if (!isNaN(asDate.getTime())) {
    return Math.floor(asDate.getTime() / 1000);
  }

  const asNumber = Number(value);
  if (!isNaN(asNumber) && value !== "") {
    return asNumber > 1e12 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
  }

  throw new Error(
    `Invalid ${paramName}: "${value}" - pass a normal date (e.g. "2025-01-01" or an ISO datetime) or a unix timestamp.`
  );
}

/**
 * Calculate commission for a single MT5 login over [sdate, edate].
 * @param {string|number} login - MT5 account login (Account.accountNo)
 * @param {number} sdate - unix seconds
 * @param {number} edate - unix seconds
 * @returns {Promise<number>} total commission for this account
 */
async function calculateClientCommissionV2(login, sdate, edate) {
  try {
    const response = await getMT5Deals({
      login,
      from: sdate,
      to: edate,
      offset: 0,
      total: 5000,
    });

    const deals = response?.answer;
    if (!Array.isArray(deals)) return 0;

    let totalCommission = 0;

    for (const deal of deals) {
      const action = Number(deal.Action);
      const entry = Number(deal.Entry);

      if (
        (action !== DEAL_ACTION_BUY && action !== DEAL_ACTION_SELL) ||
        entry !== DEAL_ENTRY_OUT
      ) {
        continue;
      }

      const symbol = normalizeSymbol(deal.Symbol);
      const rate = COMMISSION_RATES[symbol];
      if (!rate) continue;

      const lots = Number(deal.Volume) / VOLUME_DIV;
      totalCommission += lots * rate * IB_SHARE_PERCENTAGE;
    }

    return totalCommission;
  } catch (err) {
    console.error("Error fetching MT5 deals (v2):", err.message || err);
    return 0;
  }
}

module.exports = {
  calculateClientCommissionV2,
  normalizeSymbol,
  parseToUnixSeconds,
  COMMISSION_RATES,
  IB_SHARE_PERCENTAGE,
};
