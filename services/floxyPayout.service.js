// Floxy VND bank payouts for withdrawals.
//
// Request time (payout.controller createPayoutRequest): VND amount, rate locked,
// MT5 debited in USD, withdrawal saved Pending - same as every other method.
// Admin Approve (this service): pay only if the Floxy payout wallet holds enough
// VND; otherwise the withdrawal stays Pending and the team tops the wallet up in
// the Floxy panel, then approves again. Results arrive by webhook (payout.paid /
// payout.failed) or the admin "check status" action; failures keep the funds
// held, as for RameePay/Cregis (admin retries or rejects & refunds).
// The broker absorbs Floxy's payout fee.
const PAYOUT_CURRENCY = "VND";
const INSUFFICIENT = "insufficient_funds";
const OPEN_STATUSES = ["Pending", "Failed", "Processing"];

const vnd = value => `VND ${Number(value).toLocaleString("en-US")}`;

// GET /v1/balances is documented (guide section 11) without a response example,
// so read it defensively: find the VND entry, keep its numeric fields for display,
// and use a field named like "payout…available" as the payout wallet balance. If
// none can be identified the pre-check is skipped and Floxy's own
// insufficient_funds answer enforces the rule.
function parseVndBalance(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : Array.isArray(body?.balances) ? body.balances : null;
  let entry = null;
  if (list) entry = list.find(item => String(item?.currency || "").toUpperCase() === PAYOUT_CURRENCY) || null;
  else if (body && typeof body === "object") entry = body.VND || body.vnd || body.balances?.VND || null;
  if (!entry || typeof entry !== "object") return { found: false, fields: {}, payoutAvailable: null, payoutField: null };

  const fields = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === "number" && Number.isFinite(value)) fields[key] = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (typeof innerValue === "number" && Number.isFinite(innerValue)) fields[`${key}.${inner}`] = innerValue;
      }
    }
  }
  const payoutKeys = Object.keys(fields).filter(key => /payout/i.test(key));
  const payoutField = payoutKeys.find(key => /avail/i.test(key)) || (payoutKeys.length === 1 ? payoutKeys[0] : null);
  return { found: true, fields, payoutAvailable: payoutField ? fields[payoutField] : null, payoutField };
}

function insufficientMessage(available, needed) {
  const have = available === null || available === undefined ? "" : ` (available ${vnd(available)}, this withdrawal needs ${vnd(needed)})`;
  return `The Floxy payout wallet doesn't have enough VND${have}. Move funds to the payout wallet in the Floxy panel, then approve again. The request stays Pending.`;
}

// Our withdrawal status for a Floxy payout object.
function transitionFor(payout) {
  const failureCode = String(payout.failure?.code || "");
  let status;
  let insufficient = false;
  switch (payout.status) {
    case "paid": status = "Completed"; break;
    case "failed":
      if (failureCode === INSUFFICIENT) { status = "Pending"; insufficient = true; } else status = "Failed";
      break;
    case "canceled": status = "Failed"; break;
    default: status = "Processing"; // processing, pending_approval, or anything not yet final
  }
  const set = {
    status,
    "floxy.payoutId": payout.id,
    "floxy.status": String(payout.status || ""),
    "floxy.needsReview": Boolean(payout.needs_review),
    "floxy.failureCode": failureCode,
    "floxy.networkDeclineCode": String(payout.network_decline_code || ""),
    "floxy.pendingKey": "",
    "floxy.lastMessage": insufficient ? insufficientMessage(null) : "",
    response: payout,
  };
  if (typeof payout.fee === "number") set["floxy.fee"] = payout.fee;
  if (status === "Completed") {
    set.processType = "Floxy API (VND)";
    set.transactionReference = String(payout.bank_reference || "");
  }
  return { status, insufficient, set };
}

function createFloxyPayout({ client, withdrawals, contactFor = async () => null, notifyPaid = async () => {}, logger = console }) {
  async function payoutBalance() {
    return parseVndBalance(await client.getBalances());
  }

  // Applies a Floxy payout to its withdrawal once. A withdrawal already
  // Completed/Rejected is never touched, so a webhook racing the approval reply
  // cannot send the success email twice. requirePayoutMatch ignores events for
  // an older attempt once a newer payout is on the withdrawal.
  async function record(withdrawal, payout, { requirePayoutMatch }) {
    const transition = transitionFor(payout);
    const filter = { _id: withdrawal._id, status: { $in: OPEN_STATUSES } };
    if (requirePayoutMatch) filter["floxy.payoutId"] = { $in: [payout.id, "", null] };
    const updated = await withdrawals.findOneAndUpdate(filter, { $set: transition.set }, { new: true });
    if (updated && transition.status === "Completed") {
      await notifyPaid(updated).catch(error => logger.error(`Floxy payout email failed for ${updated.orderid}: ${error.message}`));
    }
    return { ...transition, withdrawal: updated };
  }

  async function approve(withdrawal) {
    if (withdrawal.currency !== PAYOUT_CURRENCY) return { ok: false, status: 400, message: "Floxy payouts are for VND withdrawals only." };
    const amount = Number(withdrawal.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, status: 400, message: "This withdrawal has an invalid VND amount." };
    if (!withdrawal.name || !withdrawal.account || !withdrawal.bankName) {
      return { ok: false, status: 400, message: "Bank details are incomplete (account holder, account number and bank name are required)." };
    }

    // A pending key means the previous attempt's result is unknown: resend it
    // with the same key (Floxy returns the original payout) and skip the
    // balance pre-check, which could wrongly block an already-created payout.
    let key = withdrawal.floxy?.pendingKey || "";
    if (!key) {
      try {
        const balance = await payoutBalance();
        if (balance.payoutAvailable !== null && balance.payoutAvailable < amount) {
          const message = insufficientMessage(balance.payoutAvailable, amount);
          await withdrawals.updateOne({ _id: withdrawal._id }, { $set: { "floxy.lastMessage": message } });
          return { ok: false, status: 409, code: "insufficient_payout_balance", message };
        }
      } catch (error) {
        logger.error(`Floxy balance check failed for ${withdrawal.orderid}; relying on Floxy's own check: ${error.message}`);
      }

      const attempts = (withdrawal.floxy?.attempts || 0) + 1;
      key = `${withdrawal.orderid}-${attempts}`;
      const claimed = await withdrawals.findOneAndUpdate(
        { _id: withdrawal._id, status: { $in: ["Pending", "Failed"] }, "floxy.pendingKey": { $in: ["", null] } },
        { $set: { "floxy.attempts": attempts, "floxy.pendingKey": key } },
        { new: true });
      if (!claimed) return { ok: false, status: 409, message: "This withdrawal is already being processed. Refresh the list and try again." };
    }

    const contact = await contactFor(withdrawal).catch(() => null);
    const body = {
      amount, currency: PAYOUT_CURRENCY,
      description: `BillionDollarFX withdrawal ${withdrawal.orderid}`,
      reference: withdrawal.orderid,
      beneficiary: {
        label: withdrawal.name,
        destination: {
          bank_account: {
            account_holder_name: withdrawal.name,
            account_number: withdrawal.account,
            bank_name: withdrawal.bankName,
            ...(withdrawal.floxy?.routingCode ? { routing_code: withdrawal.floxy.routingCode } : {}),
            bank_country: "VN",
          },
          ...(contact ? { contact } : {}),
        },
      },
    };

    let payout;
    try {
      payout = await client.createPayout(body, key);
    } catch (error) {
      if (error.code === "floxy_config") {
        // Sealing failed before anything was sent: release the attempt.
        await withdrawals.updateOne({ _id: withdrawal._id }, { $set: { "floxy.pendingKey": "" } });
        logger.error(`Floxy payout not sent for ${withdrawal.orderid}: ${error.message}`);
        return { ok: false, status: 503, message: "Floxy payouts are not configured (Secret Key / IV). Nothing was sent." };
      }
      if (error.code === INSUFFICIENT) {
        const message = insufficientMessage(null, amount);
        await withdrawals.updateOne({ _id: withdrawal._id }, { $set: { "floxy.pendingKey": "", "floxy.lastMessage": message } });
        return { ok: false, status: 409, code: "insufficient_payout_balance", message };
      }
      const definitive = error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status);
      if (definitive) {
        await withdrawals.updateOne({ _id: withdrawal._id }, { $set: {
          status: "Failed", "floxy.pendingKey": "", "floxy.failureCode": String(error.code || ""),
          "floxy.lastMessage": `Floxy refused the payout${error.code ? `: ${error.code}` : ""}.`, response: { error: error.code || error.status },
        } });
        return { ok: false, status: 400, message: `Floxy refused the payout${error.code ? ` (${error.code})` : ""}. Funds stay held: fix and retry, or reject & refund.` };
      }
      // Timeout, network error, 5xx: Floxy may or may not have created it.
      await withdrawals.updateOne({ _id: withdrawal._id }, { $set: { "floxy.lastMessage": "Floxy's answer could not be confirmed. Approve again: the same request is reused, never paid twice." } });
      logger.error(`Floxy payout for ${withdrawal.orderid} has an unknown outcome: ${error.message}`);
      return { ok: false, status: 502, message: "Couldn't confirm the payout with Floxy. Approve again: the same request is reused and can't be paid twice." };
    }

    if (typeof payout?.id !== "string" || !payout.id) {
      logger.error(`Floxy payout for ${withdrawal.orderid} returned no id; keys: ${Object.keys(payout || {}).join(",")}`);
      return { ok: false, status: 502, message: "Floxy's answer could not be read. Approve again: the same request is reused and can't be paid twice." };
    }

    const result = await record(withdrawal, payout, { requirePayoutMatch: false });
    if (result.insufficient) return { ok: false, status: 409, code: "insufficient_payout_balance", message: insufficientMessage(null, amount), data: result.withdrawal };
    if (result.status === "Completed") return { ok: true, message: "Payout paid by Floxy.", data: result.withdrawal };
    if (result.status === "Processing") {
      const extra = payout.status === "pending_approval" ? " It is waiting for Floxy's internal approval." : payout.needs_review ? " Floxy is reviewing it with the bank." : "";
      return { ok: true, message: `Payout sent to Floxy and is processing.${extra} The result arrives automatically.`, data: result.withdrawal };
    }
    return { ok: false, status: 400, message: `Floxy payout failed${result.set["floxy.failureCode"] ? ` (${result.set["floxy.failureCode"]})` : ""}. Funds stay held: retry or reject & refund.`, data: result.withdrawal };
  }

  async function handleEvent(event) {
    if (!String(event?.type || "").startsWith("payout.")) return { handled: false };
    const payoutId = event?.data?.object?.id;
    if (typeof payoutId !== "string" || !payoutId) return { handled: false };
    // The event is only a trigger: read the payout with our key.
    const payout = await client.getPayout(payoutId);
    const withdrawal = await withdrawals.findOne({ currency: PAYOUT_CURRENCY, "floxy.payoutId": payout.id }) ||
      (payout.reference ? await withdrawals.findOne({ currency: PAYOUT_CURRENCY, orderid: String(payout.reference) }) : null);
    if (!withdrawal) {
      logger.error(`Floxy payout event for ${payout.id} matched no withdrawal`);
      return { handled: false };
    }
    const result = await record(withdrawal, payout, { requirePayoutMatch: true });
    return { handled: true, result: result.withdrawal ? result.status : "unchanged" };
  }

  async function refresh(withdrawal) {
    if (!withdrawal.floxy?.payoutId) {
      return { ok: false, status: 400, message: withdrawal.floxy?.pendingKey
        ? "The last attempt was not confirmed. Approve again: the same request is reused."
        : "No Floxy payout has been created for this withdrawal yet." };
    }
    const payout = await client.getPayout(withdrawal.floxy.payoutId);
    const result = await record(withdrawal, payout, { requirePayoutMatch: true });
    return { ok: true, message: `Floxy status: ${payout.status}${payout.needs_review ? " (under review)" : ""}.`, data: result.withdrawal || withdrawal };
  }

  return { approve, handleEvent, refresh, payoutBalance };
}

let defaultService;
function service() {
  if (!defaultService) {
    const { createClient } = require("../utils/floxyClient");
    const Account = require("../models/account.model");
    defaultService = createFloxyPayout({
      client: createClient(),
      withdrawals: require("../models/withdrawal"),
      contactFor: async withdrawal => {
        const account = await Account.findOne({ accountNo: Number(withdrawal.accountNo) }).populate("user");
        const user = account?.user;
        if (!user?.email && !user?.phone) return null;
        return {
          name: withdrawal.name,
          ...(user.email ? { email: user.email } : {}),
          ...(user.phone ? { phone: String(user.phone) } : {}),
        };
      },
      notifyPaid: withdrawal => require("../controllers/payout.controller").sendSuccessEmail(withdrawal),
    });
  }
  return defaultService;
}

module.exports = { createFloxyPayout, parseVndBalance, transitionFor, service, PAYOUT_CURRENCY };
