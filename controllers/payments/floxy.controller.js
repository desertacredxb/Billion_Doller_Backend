const crypto = require("crypto");
const Account = require("../../models/account.model");
const { verifySignature, isConfigured, unseal } = require("../../utils/floxyClient");
const { service, fetchVndPerUsd, minimumVnd } = require("../../services/floxyDeposit.service");
const { MIN_DEPOSIT_USD } = require("../../config/depositLimits");

const UNAVAILABLE = { success: false, message: "Floxy deposits are not available right now." };

// Current rate and minimum for the deposit form. The rate actually used is
// locked again server-side when the payment link is created.
exports.getFloxyQuote = async (req, res) => {
  if (!isConfigured()) return res.status(503).json(UNAVAILABLE);
  try {
    const vndPerUsd = await fetchVndPerUsd();
    return res.json({ success: true, currency: "VND", vndPerUsd, minVnd: minimumVnd(vndPerUsd), minUsd: MIN_DEPOSIT_USD });
  } catch {
    return res.status(503).json({ success: false, message: "The VND exchange rate is unavailable. Please try again shortly." });
  }
};

exports.createFloxyDeposit = async (req, res) => {
  if (!isConfigured()) return res.status(503).json(UNAVAILABLE);
  try {
    const { accountNo } = req.body;
    const vndAmount = Number(req.body.amount);
    if (!Number.isSafeInteger(vndAmount) || vndAmount <= 0) {
      return res.status(400).json({ success: false, message: "Enter a whole VND amount." });
    }

    const account = await Account.findOne({ accountNo: Number(accountNo) });
    if (!account) return res.status(404).json({ success: false, message: "Account not found" });

    let result;
    try {
      result = await service().createDeposit({
        account, vndAmount,
        makeOrderId: () => `FLX${Date.now()}${crypto.randomInt(1000, 10000)}`,
      });
    } catch (error) {
      if (/exchange rate/i.test(error.message)) {
        return res.status(503).json({ success: false, message: "The VND exchange rate is unavailable. Please try again shortly." });
      }
      throw error;
    }

    if (!result.ok) return res.status(result.status).json({ success: false, message: result.message, minVnd: result.minVnd });
    const { ok, ...data } = result;
    return res.status(201).json({ success: true, ...data });
  } catch (error) {
    console.error("Floxy deposit error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to start the deposit. Please try again shortly." });
  }
};

const payoutService = () => require("../../services/floxyPayout.service").service();

// Floxy "Payout Callback" URL (payout.paid / payout.failed). The guide does not
// say whether payout callbacks use a separate secret, so a dedicated
// FLOXY_PAYOUT_WEBHOOK_SECRET is accepted alongside the webhook secret.
// Mounted with express.raw(): the signature covers the original bytes.
exports.handleFloxyPayoutCallback = async (req, res) => {
  if (!isConfigured()) return res.status(503).json(UNAVAILABLE);
  const secrets = [process.env.FLOXY_PAYOUT_WEBHOOK_SECRET, process.env.FLOXY_WEBHOOK_SECRET].filter(Boolean);
  if (!secrets.some(secret => verifySignature(req.body, req.get("floxy-signature"), secret))) {
    return res.status(401).json({ success: false, message: "Invalid signature" });
  }
  let event;
  try { event = unseal(JSON.parse(req.body.toString("utf8"))); } catch {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }
  try {
    const outcome = await payoutService().handleEvent(event);
    return res.status(200).json({ received: true, ...outcome });
  } catch (error) {
    // Floxy lookup or storage failed: let Floxy retry.
    console.error(`Floxy payout callback ${event?.id || ""} failed:`, error.message);
    return res.status(500).json({ received: false });
  }
};

// Admin: the Floxy VND balance figures, shown before approving a VND payout.
exports.getFloxyPayoutBalance = async (_req, res) => {
  if (!isConfigured()) return res.status(503).json(UNAVAILABLE);
  try {
    const balance = await payoutService().payoutBalance();
    return res.json({ success: true, currency: "VND", ...balance });
  } catch (error) {
    console.error("Floxy balance lookup failed:", error.message);
    return res.status(502).json({ success: false, message: "Couldn't read the Floxy balance right now." });
  }
};

// Admin: re-read a VND withdrawal's payout from Floxy (missed webhook, stuck processing).
exports.refreshFloxyPayout = async (req, res) => {
  if (!isConfigured()) return res.status(503).json(UNAVAILABLE);
  try {
    const withdrawal = await require("../../models/withdrawal").findById(req.params.id);
    if (!withdrawal || withdrawal.currency !== "VND") return res.status(404).json({ success: false, message: "VND withdrawal not found." });
    const result = await payoutService().refresh(withdrawal);
    return res.status(result.ok ? 200 : result.status).json({ success: result.ok, message: result.message, data: result.data });
  } catch (error) {
    console.error("Floxy payout refresh failed:", error.message);
    return res.status(502).json({ success: false, message: "Couldn't reach Floxy right now. Try again shortly." });
  }
};

// Mounted with express.raw(): the signature covers the original bytes.
exports.handleFloxyCallback = async (req, res) => {
  if (!isConfigured()) return res.status(503).json(UNAVAILABLE);
  if (!verifySignature(req.body, req.get("floxy-signature"), process.env.FLOXY_WEBHOOK_SECRET)) {
    return res.status(401).json({ success: false, message: "Invalid signature" });
  }

  let event;
  try { event = JSON.parse(req.body.toString("utf8")); } catch {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }
  // With sealed responses enabled the event body may be {"data": "<encrypted>"}.
  try { event = unseal(event); } catch (error) {
    console.error("Floxy callback could not be decrypted:", error.message);
    return res.status(500).json({ received: false });
  }

  try {
    // Payout events registered on this endpoint are handled like the payout callback.
    const outcome = String(event?.type || "").startsWith("payout.")
      ? await payoutService().handleEvent(event)
      : await service().handleEvent(event);
    return res.status(200).json({ received: true, ...outcome });
  } catch (error) {
    // Another worker holds the claim, or a credit is locked for manual review:
    // a Floxy retry cannot change that, so acknowledge.
    if (/being processed|requires reconciliation|claim was lost/i.test(error.message)) {
      return res.status(200).json({ received: true, result: "review" });
    }
    // Anything before the MT5 call (e.g. Floxy lookup failed) is safe to retry.
    console.error(`Floxy callback ${event?.id || ""} failed:`, error.message);
    return res.status(500).json({ received: false });
  }
};
