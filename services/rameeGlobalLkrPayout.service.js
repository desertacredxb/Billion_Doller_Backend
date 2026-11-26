const axios = require("axios");
const { RaamiClient } = require("../utils/raamiClient");
const { readLkrMinor } = require("../utils/rameeGlobalProtocol");
const { MIN_WITHDRAWAL_USD } = require("../config/withdrawalLimits");

// Live rate feed (the same one Floxy VND uses), used when no custom rate is set.
// A value outside the bounds means the feed is broken, so it is refused.
const RATE_URL = "https://open.er-api.com/v6/latest/USD";
const LKR_PER_USD_BOUNDS = [100, 1000];
const RATE_CACHE_MS = 10 * 60 * 1000;

// LKR withdrawals through RameeGlobalPay.
//   Bank list      RaamiClient.getPayoutMethods("LKR")
//   Create payout  RaamiClient.createPayout(...)
//   Result         arrives on the payout callback (rameeGlobalLkrPayoutCallback.service.js),
//                  which matches the withdrawal on orderid + rameeGlobalLkr.payoutId.
//
// Env:
//   RAMEE_GLOBAL_LKR_AGENT_CODE, RAMEE_GLOBAL_LKR_ACCESS_KEY   same credentials the LKR deposit uses
//   RAMEE_GLOBAL_LKR_STAGING_LKR_PER_USD                       optional custom rate, e.g. 300 or 300.50.
//                                                              When set it overrides the live rate.

function createLkrPayoutService({
  withdrawals,
  env = process.env,
  makeClient = (agentCode, accessKey) => new RaamiClient("production", agentCode, accessKey),
  http = axios,
  now = () => Date.now(),
} = {}) {
  let rateCache = { at: 0, minor: 0 };

  // Returns { client } or null when the LKR credentials are missing.
  function setup(scope) {
    try {
      const { RAMEE_GLOBAL_LKR_AGENT_CODE: agentCode, RAMEE_GLOBAL_LKR_ACCESS_KEY: accessKey } = env;
      if (!agentCode || !accessKey) throw new Error("LKR agent code or access key is missing.");
      return { client: makeClient(agentCode, accessKey) };
    } catch (error) {
      console.error(`[RameeGlobalLKR] payout ${scope}: ${error.message}`);
      return null;
    }
  }

  // LKR per USD in cents (e.g. 300.50 -> 30050). A custom rate in
  // RAMEE_GLOBAL_LKR_STAGING_LKR_PER_USD always wins; without it the live rate
  // is used (cached for 10 minutes). Returns 0 when no rate is available.
  async function getLkrMinorPerUsd() {
    const customRate = env.RAMEE_GLOBAL_LKR_STAGING_LKR_PER_USD;
    if (customRate) {
      try {
        const custom = readLkrMinor(customRate);
        if (custom > 0) return custom;
      } catch { /* invalid, reported below */ }
      // Refuse rather than silently ignore a custom rate someone set on purpose.
      console.error(`[RameeGlobalLKR] RAMEE_GLOBAL_LKR_STAGING_LKR_PER_USD is invalid (use e.g. 300 or 300.50): ${JSON.stringify(customRate)}`);
      return 0;
    }

    if (rateCache.minor && now() - rateCache.at < RATE_CACHE_MS) return rateCache.minor;
    try {
      const { data } = await http.get(RATE_URL, { timeout: 10000 });
      const rate = Number(data?.rates?.LKR);
      if (data?.result === "success" && rate >= LKR_PER_USD_BOUNDS[0] && rate <= LKR_PER_USD_BOUNDS[1]) {
        rateCache = { at: now(), minor: Math.round(rate * 100) };
        return rateCache.minor;
      }
      console.error("[RameeGlobalLKR] live LKR rate looks wrong:", data?.rates?.LKR);
    } catch (error) {
      console.error(`[RameeGlobalLKR] live LKR rate unavailable: ${error.message}`);
    }
    return 0;
  }

  // Bank list for the withdrawal form. { ok: true, methods } or { ok: false, status, message }.
  async function loadMethods() {
    const ctx = setup("loadMethods");
    if (!ctx) return { ok: false, status: 503, message: "LKR withdrawals are unavailable." };
    const result = await ctx.client.getPayoutMethods("LKR");
    const list = result.data?.methods;
    if (!result.success || !Array.isArray(list)) {
      return { ok: false, status: result.httpStatus >= 400 ? result.httpStatus : 502, message: result.message || "Failed to get LKR banks" };
    }
    return { ok: true, methods: list.map(({ code, description }) => ({ code, description: description || code })) };
  }

  // Rate and minimum the withdrawal form shows (the request itself is re-checked server side).
  async function quote() {
    const lkrMinorPerUsd = await getLkrMinorPerUsd();
    if (!lkrMinorPerUsd) return null;
    const lkrPerUsd = lkrMinorPerUsd / 100;
    return { lkrPerUsd, minLkr: Math.ceil(MIN_WITHDRAWAL_USD * lkrPerUsd) };
  }

  // Checks a withdrawal request before any money moves. Returns
  // { ok: true, amountLkr, usd, bankCode, bankName, account, holder, lkrPerUsd } or { ok: false, status, message }.
  async function prepareRequest(body = {}) {
    const fail = (message, status = 400) => ({ ok: false, status, message });
    const ctx = setup("prepareRequest");
    if (!ctx) return fail("LKR withdrawals are unavailable.", 503);
    const lkrMinorPerUsd = await getLkrMinorPerUsd();
    if (!lkrMinorPerUsd) return fail("The LKR exchange rate is unavailable. Please try again shortly.", 503);

    let amountMinor;
    try { amountMinor = readLkrMinor(body.amount); } catch {
      return fail("Enter a valid LKR amount with up to two decimal places.");
    }
    if (amountMinor <= 0) return fail("Enter a valid LKR amount with up to two decimal places.");

    // Round the USD debit up to the cent so the client is never under-charged.
    const usdCents = Math.ceil((amountMinor * 100) / lkrMinorPerUsd);
    const usd = usdCents / 100;
    if (usd < MIN_WITHDRAWAL_USD) return fail(`The minimum withdrawal amount is US$${MIN_WITHDRAWAL_USD}.`);

    const bankCode = typeof body.bankCode === "string" ? body.bankCode.trim() : "";
    const account = ["string", "number"].includes(typeof body.account) ? String(body.account).trim() : "";
    const holder = String(body.accountHolderName || body.name || "").trim();
    if (!bankCode) return fail("Select a bank for the LKR withdrawal.");
    if (!/^[A-Za-z0-9-]{4,34}$/.test(account)) return fail("Enter a valid bank account number.");
    if (!holder || holder.length > 100) return fail("Enter the account holder name.");

    const loaded = await loadMethods();
    if (!loaded.ok) return fail("The LKR bank list is unavailable. Please try again shortly.", 503);
    const bank = loaded.methods.find(method => method.code === bankCode);
    if (!bank) return fail("The selected bank is not supported for LKR withdrawals.");

    return {
      ok: true,
      amountLkr: amountMinor / 100,
      usd,
      bankCode,
      bankName: bank.description || bankCode,
      account,
      holder,
      lkrPerUsd: lkrMinorPerUsd / 100,
    };
  }

  // Sends an approved LKR withdrawal to RameeGlobalPay. The withdrawal is claimed
  // (Processing) before sending so a double click cannot pay twice. An attempt whose
  // outcome is unknown stays Processing and is never re-sent automatically.
  // Returns { ok, status, code, message, data }.
  async function approve(withdrawal) {
    const ctx = setup("approve");
    if (!ctx) return { ok: false, status: 503, code: "UNAVAILABLE", message: "LKR payouts are unavailable." };

    const bankCode = withdrawal.rameeGlobalLkr?.bankCode;
    if (!bankCode || !withdrawal.account) {
      return { ok: false, status: 400, code: "MISSING_BANK", message: "The bank code or account number is missing. Process this payout manually." };
    }

    const claimed = await withdrawals.findOneAndUpdate(
      { _id: withdrawal._id, currency: "LKR", status: { $in: ["Pending", "Failed"] } },
      { $set: { status: "Processing", processType: "RameeGlobalPay API (LKR)", "rameeGlobalLkr.approvedAt": new Date() } },
      { new: true, writeConcern: { w: "majority", j: true } }
    );
    if (!claimed) return { ok: false, status: 409, code: "IN_PROGRESS", message: "This withdrawal is already being processed." };

    const result = await ctx.client.createPayout({
      currency: "LKR",
      amount: Number(withdrawal.amount),
      orderid: withdrawal.orderid,
      note: "LKR Withdrawal",
      orderDetail: { code: bankCode, account: String(withdrawal.account) },
    });

    const providerOrderId = result.data?.orderid;
    if (result.success && providerOrderId) {
      const updated = await withdrawals.findOneAndUpdate({ _id: withdrawal._id }, {
        $set: { "rameeGlobalLkr.payoutId": providerOrderId, response: result },
      }, { new: true });
      return { ok: true, status: 200, code: "SUBMITTED", message: "LKR payout submitted and awaiting confirmation.", data: updated };
    }

    // No HTTP status, a server error, or a "success" without a payout id: the payout may
    // still have been queued, so leave it Processing for the admin to check.
    const unconfirmed = result.success || !result.httpStatus || result.httpStatus >= 500;
    if (unconfirmed) {
      await withdrawals.updateOne({ _id: withdrawal._id }, { $set: { response: result } });
      return { ok: false, status: 502, code: "UNCONFIRMED", message: "The LKR payout was not confirmed. Check it in the RameeGlobalPay panel before doing anything else." };
    }

    await withdrawals.updateOne({ _id: withdrawal._id }, { $set: { status: "Failed", response: result } });
    return { ok: false, status: 400, code: "REJECTED", message: result.message || "RameeGlobalPay rejected the payout. You can retry, process it manually or reject it to refund." };
  }

  return { loadMethods, quote, prepareRequest, approve };
}

module.exports = { createLkrPayoutService };
