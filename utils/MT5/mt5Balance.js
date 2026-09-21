const Account = require("../../models/account.model");
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

    // 1. Authenticate with MT5 Manager credentials
    await new Promise((resolve, reject) => {
      mt5.Auth(
        process.env.MT5_MANAGER_LOGIN,
        process.env.MT5_MANAGER_PASSWORD,
        process.env.MT5_BUILD,
        "WebManager",
        (error) => (error ? reject(error) : resolve())
      );
    });

    // 2. Execute Balance Update
    return new Promise((resolve, reject) => {
      mt5.TradeBalance({ login, type, balance, comment }, (error, answer) => {
        if (error) return reject(error);
        resolve(answer);
      });
    });
  });
}

async function refundToMoneyPlant(accountNo, amount, currency = "USD") {
  const refundAmount = Math.abs(Number(amount));

  if (!accountNo || isNaN(refundAmount) || refundAmount <= 0) {
    throw new Error("Invalid parameters: Valid accountNo and positive refund amount are required.");
  }

  // 1. Verify the account exists in MongoDB
  const account = await Account.findOne({ accountNo: String(accountNo) });
  if (!account) {
    throw new Error(`MoneyPlant Account '${accountNo}' not found.`);
  }

  const comment = `Refund credit (${currency}) - Auto System`;

  // 2. Deposit the refund amount back into the MT5 Account via TradeBalance
  const mt5Answer = await updateMT5Balance({
    login: String(accountNo),
    type: 2, // 2 = Balance adjustment/deposit in MT5 WebAPI
    balance: refundAmount,
    comment: comment,
    
  });

  // 3. Increment the balance in MongoDB
  const updatedAccount = await Account.findOneAndUpdate(
    { accountNo: String(accountNo) },
    { $inc: { balance: refundAmount } },
    { new: true }
  );

  return {
    success: true,
    accountNo: String(accountNo),
    refundedAmount: refundAmount,
    currency,
    mt5Ticket: mt5Answer?.ticket || mt5Answer?.answer || mt5Answer,
    account: updatedAccount,
  };
}

module.exports = { updateMT5Balance, runExclusive , refundToMoneyPlant};