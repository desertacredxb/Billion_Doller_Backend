const User = require("../models/User");
const IB = require("../models/Broker.model");

async function checkIBStorage({ users = User, brokers = IB } = {}) {
  await brokers.init();
  const indexes = await brokers.listIndexes();
  for (const field of ["user", "referralCode"]) {
    if (!indexes.some(index => index.unique === true && index.sparse === true &&
        Object.keys(index.key).length === 1 && index.key[field] === 1)) {
      throw new Error("IB approval requires its sparse unique indexes.");
    }
  }
  const session = await users.startSession();
  try {
    session.startTransaction();
    // No client data is loaded or changed. The server must accept transaction reads.
    await users.findOne({ _id: null }).select("_id").session(session).lean();
    await brokers.findOne({ _id: null }).select("_id").session(session).lean();
    await session.abortTransaction();
  } finally {
    await session.endSession();
  }
}

async function checkOnStartup({ env = process.env, check = checkIBStorage, logger = console } = {}) {
  if (!env.VERIFF_API_KEY || !env.VERIFF_SHARED_SECRET) return;
  try {
    await check();
    logger.info("Veriff IB storage preflight passed: transactions and unique indexes ready.");
  } catch {
    // Driver errors can contain connection details; only log the readiness result.
    logger.error("Veriff IB storage preflight failed; automated IB approval cannot start.");
    if (env.VERIFF_ENABLED === "true" && env.VERIFF_IB_AUTO_APPROVAL === "true") {
      throw new Error("Veriff IB storage is not ready.");
    }
  }
}

module.exports = { checkIBStorage, checkOnStartup };
