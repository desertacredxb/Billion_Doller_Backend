// MT5 deal-history and account-state services for the IB referral system.
//
// NOT wired into commissionService.js or ibController.js yet - this is
// standalone plumbing so the calls can be verified independently before
// anything depends on them for real commission numbers. See
// scripts/testMT5DealServices.js for a read-only smoke test.

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
 * Fetch a login's deal history in [from, to] (unix seconds), one page at a
 * time. Returns whatever the MT5 facade responds with, unnormalized -
 * callers are responsible for interpreting Symbol/Volume/Action/Entry once
 * this is actually wired into commission calculation.
 */
async function getMT5Deals({ login, from, to, offset = 0, total = 1000 }) {
  if (!login || from === undefined || to === undefined) {
    throw new Error("getMT5Deals requires login, from and to");
  }

  return runExclusive(async () => {
    const mt5 = new MT5Request(process.env.MT5_SERVER, 1950);
    await authenticate(mt5);

    return new Promise((resolve, reject) => {
      mt5.DealGetPage({ login, from, to, offset, total }, (error, answer) => {
        if (error) return reject(error);
        resolve(answer);
      });
    });
  });
}

/**
 * Count of deals for a login in [from, to] (unix seconds) - useful for
 * paging getMT5Deals when the number of trades isn't known ahead of time.
 */
async function getMT5DealsTotal({ login, from, to }) {
  if (!login || from === undefined || to === undefined) {
    throw new Error("getMT5DealsTotal requires login, from and to");
  }

  return runExclusive(async () => {
    const mt5 = new MT5Request(process.env.MT5_SERVER, 1950);
    await authenticate(mt5);

    return new Promise((resolve, reject) => {
      mt5.DealGetTotal({ login, from, to }, (error, answer) => {
        if (error) return reject(error);
        resolve(answer);
      });
    });
  });
}

/**
 * Fetch a login's live account state (Balance/Margin/MarginFree/Equity/...).
 */
async function getMT5Account({ login }) {
  if (!login) {
    throw new Error("getMT5Account requires login");
  }

  return runExclusive(async () => {
    const mt5 = new MT5Request(process.env.MT5_SERVER, 1950);
    await authenticate(mt5);

    return new Promise((resolve, reject) => {
      mt5.AccountGet(login, (error, answer) => {
        if (error) return reject(error);
        resolve(answer);
      });
    });
  });
}

module.exports = { getMT5Deals, getMT5DealsTotal, getMT5Account, runExclusive };
