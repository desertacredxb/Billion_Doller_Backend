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

// Placeholder for the Floxy "Payout Callback" URL. Withdrawals via Floxy are
// not built yet, so no payouts exist to report on: verify and acknowledge only.
// Mounted with express.raw(): the signature covers the original bytes.
exports.handleFloxyPayoutCallback = async (req, res) => {
  if (!isConfigured()) return res.status(503).json(UNAVAILABLE);
  if (!verifySignature(req.body, req.get("floxy-signature"), process.env.FLOXY_WEBHOOK_SECRET)) {
    return res.status(401).json({ success: false, message: "Invalid signature" });
  }
  let event;
  try { event = unseal(JSON.parse(req.body.toString("utf8"))); } catch {
    return res.status(400).json({ success: false, message: "Invalid payload" });
  }
  console.log(`Floxy payout callback received (not processed yet): ${event?.type || "unknown"} ${event?.id || ""}`);
  return res.status(200).json({ received: true, handled: false });
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
    const outcome = await service().handleEvent(event);
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
