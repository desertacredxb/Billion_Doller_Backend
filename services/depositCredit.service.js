const { AsyncLocalStorage } = require("node:async_hooks");
const { randomUUID } = require("node:crypto");
const contexts = new AsyncLocalStorage();
const durable = { writeConcern: { w: "majority", j: true } };
const moneyCents = amount => {
  const value = Number(amount);
  const result = Math.round(value * 100);
  if (!Number.isFinite(value) || !Number.isSafeInteger(result) || result < 0) throw new Error("Invalid deposit amount");
  return result;
};

function createGuard({ orders, updateBalance, now = () => new Date(), logger = console }) {
  let ready;
  function checkReadiness() {
    ready ||= (async () => {
      const indexes = await orders.collection.indexes();
      if (!indexes.some(index => index.unique && !index.partialFilterExpression && !index.sparse &&
          Object.keys(index.key).length === 1 && index.key.orderid === 1)) {
        throw new Error("Deposit order uniqueness index is required");
      }
    })().catch(error => { ready = undefined; throw error; });
    return ready;
  }
  async function run(orderId, work, duplicate = () => undefined) {
    if (typeof orderId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(orderId)) throw new Error("Invalid deposit reference");
    await checkReadiness();
    const token = randomUUID();
    const order = await orders.findOneAndUpdate({
      orderid: orderId, status: { $ne: "SUCCESS" },
      "settlementAttempt.state": { $nin: ["processing", "submitting", "review"] },
    }, { $set: { settlementAttempt: { token, state: "processing", startedAt: now() } } }, { new: true, ...durable });
    if (!order) {
      const current = await orders.findOne({ orderid: orderId });
      if (current?.status === "SUCCESS") return duplicate();
      throw new Error("Deposit is being processed or requires reconciliation");
    }
    const claim = { _id: order._id, "settlementAttempt.token": token };
    const previous = moneyCents(order.creditedAmount || 0);
    const accountNo = String(order.accountNo);
    const context = { attempted: false, succeeded: false, target: previous, ticket: "" };
    context.submit = async options => {
      if (context.attempted) throw new Error("A deposit cannot submit two balance updates");
      const delta = moneyCents(options.balance);
      if (!delta || String(options.login) !== accountNo || Number(options.type ?? 2) !== 2) throw new Error("Invalid deposit balance update");
      context.target = previous + delta;
      if (!Number.isSafeInteger(context.target)) throw new Error("Invalid deposit total");
      const marked = await orders.updateOne(claim, { $set: {
        "settlementAttempt.state": "submitting", "settlementAttempt.deltaCents": delta, "settlementAttempt.targetCents": context.target,
      } }, durable);
      if (marked.modifiedCount !== 1) throw new Error("Deposit processing claim was lost");
      // Persist before making the external call. No lease expiry/retry can
      // safely decide whether MT5 applied a credit whose response was lost.
      context.attempted = true;
      const answer = await updateBalance(options);
      if (!/^0(?:\s*Done)?$/i.test(String(answer?.retcode ?? answer?.data?.retcode ?? "").trim())) throw new Error("MT5 credit requires reconciliation");
      context.succeeded = true;
      context.ticket = String(answer.ticket || answer.data?.ticket || "");
      return { ...answer, retcode: "0 Done" };
    };
    try {
      return await contexts.run(context, () => work(order));
    } finally {
      try {
        if (!context.attempted) {
          await orders.updateOne(claim, { $unset: { settlementAttempt: 1 } }, durable);
        } else {
          const current = await orders.findOne(claim);
          const committed = context.succeeded && current && (
            current.status === "SUCCESS" ||
            (current.status === "PARTIALLY_PAID" && moneyCents(current.creditedAmount || 0) === context.target)
          );
          if (committed) {
            await orders.updateOne(claim, { $set: {
              status: current.status, creditedAmount: context.target / 100, lastSettlementTicket: context.ticket,
            }, $unset: { settlementAttempt: 1 } }, durable);
          } else {
            await orders.updateOne(claim, { $set: {
              "settlementAttempt.state": "review",
              comment: "Deposit credit requires MT5/provider reconciliation. Do not clear the claim or retry before checking deal history.",
            } }, durable);
            logger.error("Deposit credit requires manual reconciliation");
          }
        }
      } catch {
        // A persisted processing/submitting claim continues to block another
        // credit after storage failure or restart. Never auto-expire it.
        logger.error("Deposit processing claim requires manual reconciliation");
      }
    }
  }
  return { run, checkReadiness };
}

async function balanceWithClaim(options) {
  const context = contexts.getStore();
  if (!context) throw new Error("Deposit processing claim is required");
  return context.submit(options);
}
let guard;
function defaultGuard() {
  guard ||= createGuard({ orders: require("../models/Order"), updateBalance: require("../utils/MT5/mt5Balance").updateMT5Balance });
  return guard;
}
function runDeposit(...args) { return defaultGuard().run(...args); }
async function checkDepositReadiness({ guard: connectedGuard = defaultGuard() } = {}) {
  // Model.init() can retain an auto-create failure from before connect() when
  // buffering is disabled. Inspect the already connected collection directly,
  // as the existing Veriff storage preflight does.
  await connectedGuard.checkReadiness();
}
module.exports = { createGuard, runDeposit, balanceWithClaim, checkDepositReadiness };
