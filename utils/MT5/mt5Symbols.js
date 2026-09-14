// MT5 symbol-list service for the IB referral system.
//
// Used to resolve how broker-side symbol names are actually formatted (e.g.
// the "XAUUSD.lp" suffix seen on real deals), so the commission rate-table
// lookup in commissionService.js can be built against real symbol names
// instead of guessing. Not wired into commission calculation yet.

const MT5Request = require("../mt5Request");

let mt5Lock = Promise.resolve();
function runExclusive(fn) {
  const result = mt5Lock.then(fn, fn);
  mt5Lock = result.catch(() => {});
  return result;
}

function authenticate(mt5) {
  return new Promise((resolve, reject) => {
    mt5.Auth(
      process.env.MT5_MANAGER_LOGIN,
      process.env.MT5_MANAGER_PASSWORD,
      process.env.MT5_BUILD,
      "WebManager",
      (error) => (error ? reject(error) : resolve())
    );
  });
}

/**
 * Fetch the full list of symbols configured on the trading server.
 */
async function getMT5SymbolList() {
  return runExclusive(async () => {
    const mt5 = new MT5Request(process.env.MT5_SERVER, 1950);
    await authenticate(mt5);

    return new Promise((resolve, reject) => {
      mt5.SymbolList((error, answer) => {
        if (error) return reject(error);
        resolve(answer);
      });
    });
  });
}

module.exports = { getMT5SymbolList };
