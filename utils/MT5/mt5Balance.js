const MT5Request = require("../mt5Request");

let mt5Lock = Promise.resolve();
function runExclusive(fn) {
  const result = mt5Lock.then(fn, fn);
  mt5Lock = result.catch(() => {});
  return result;
}

async function updateMT5Balance({ login, type = 2, balance, comment }) {
  return runExclusive(async () => {
    const mt5 = new MT5Request(process.env.MT5_SERVER, 1950);

    await new Promise((resolve, reject) => {
      mt5.Auth(
        process.env.MT5_MANAGER_LOGIN,
        process.env.MT5_MANAGER_PASSWORD,
        process.env.MT5_BUILD,
        "WebManager",
        (error) => (error ? reject(error) : resolve())
      );
    });

    return new Promise((resolve, reject) => {
      mt5.TradeBalance({ login, type, balance, comment }, (error, answer) => {
        if (error) return reject(error);
        resolve(answer);
      });
    });
  });
}

module.exports = { updateMT5Balance, runExclusive };