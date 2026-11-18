const express = require("express");
const crypto = require("node:crypto");
const service = require("../services/crmInbox.service");
const provider = require("../services/crmInboxProvider");
const { Account } = require("../models/CrmInbox");
const { CrmError } = require("../services/crm.service");
const access = require("../middleware/accessControl");
const router = express.Router();
const hooks = express.Router();
const handle = action => async (req, res, next) => {
  try {
    await action(req, res);
  }
  catch (error) {
    if (error instanceof CrmError)
      return res.status(error.status).json({ message: error.message });
    if (error.code === 11000)
      return res.status(409).json({ message: "This account or conversation is already linked." });
    next(error);
  }
};
hooks.get("/whatsapp", (req, res) => {
  if (req.query["hub.mode"] !== "subscribe" || !provider.equal(process.env.BDFX_META_VERIFY_TOKEN, req.query["hub.verify_token"]) || typeof req.query["hub.challenge"] !== "string")
    return res.sendStatus(403);
  res.type("text").send(req.query["hub.challenge"]);
});
hooks.post("/whatsapp", express.raw({ type: "application/json", limit: "2mb" }), handle(async (req, res) => {
  if (!provider.settings().whatsapp || !Buffer.isBuffer(req.body))
    return res.sendStatus(403);
  const sig = "sha256=" + crypto.createHmac("sha256", process.env.BDFX_META_APP_SECRET).update(req.body).digest("hex");
  if (!provider.equal(sig, req.get("x-hub-signature-256")))
    return res.sendStatus(403);
  const payload = JSON.parse(req.body.toString());
  if (payload.object === "whatsapp_business_account") {
    await service.ready();
    await service.whatsappEvent(payload);
  }
  res.sendStatus(200);
}));
hooks.post("/telegram", express.json({ limit: "1mb" }), handle(async (req, res) => {
  if (!provider.settings().telegram || !provider.equal(process.env.BDFX_INBOX_TELEGRAM_SECRET, req.get("x-telegram-bot-api-secret-token")))
    return res.sendStatus(403);
  await service.ready();
  await service.telegramEvent(req.body);
  res.sendStatus(200);
}));
router.get("/settings", handle(async (req, res) => {
  const mine = await Account.find({ agent: req.principal.id }).select("channel enabled canReply externalId").lean();
  const state = Object.fromEntries(mine.map(a => [a.channel, a.enabled ? "connected" : a.externalId ? "awaiting provider" : "disconnected"]));
  res.json({ ...provider.settings(), state });
}));
router.post("/telegram/webhook", access.owner, handle(async (req, res) => {
  const s = provider.settings();
  if (!s.telegram)
    throw new CrmError(409, "Configure the dedicated Telegram work inbox bot first.");
  const base = String(process.env.BDFX_INBOX_API_ORIGIN || "");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(base))
    throw new CrmError(409, "Configure the public BDFX API origin first.");
  const bot = (await provider.telegram("getMe", {})).result;
  if (!bot?.can_connect_to_business || bot.username.toLowerCase() !== s.bot.toLowerCase())
    throw new CrmError(409, "Enable Business Mode on the dedicated inbox bot and check its username.");
  const url = base + "/api/crm/inbox/hooks/telegram";
  const prior = (await provider.telegram("getWebhookInfo", {})).result;
  if (prior.url && prior.url !== url)
    throw new CrmError(409, "This bot already delivers to another service. Select the dedicated inbox bot.");
  await provider.telegram("setWebhook", { url, secret_token: process.env.BDFX_INBOX_TELEGRAM_SECRET, allowed_updates: ["message", "business_connection", "business_message", "edited_business_message", "deleted_business_messages"] });
  const saved = (await provider.telegram("getWebhookInfo", {})).result;
  res.json({ saved: saved.url === url });
}));
router.post("/connect/:channel", handle(async (req, res) => {
  if (req.principal.adminRole === "owner" || req.body?.consent !== true)
    throw new CrmError(403, "The agent must authorize sharing their assigned work conversations.");
  res.json(await service.begin(req.principal.id, req.params.channel));
}));
router.post("/whatsapp/finish", handle(async (req, res) => {
  await service.whatsappFinish(req.principal.id, req.body || {});
  res.json({ saved: true });
}));
router.delete("/connect/:channel", handle(async (req, res) => {
  if (!["whatsapp", "telegram"].includes(req.params.channel))
    throw new CrmError(400, "Unknown channel.");
  await Account.deleteOne({ agent: req.principal.id, channel: req.params.channel });
  res.json({ disconnected: true });
}));
router.get("/leads/:id", handle(async (req, res) => res.json(await service.history(req.principal, req.params.id))));
router.post("/leads/:id/telegram", handle(async (req, res) => res.json(await service.telegramPair(req.principal, req.params.id))));
router.post("/leads/:id/reply", handle(async (req, res) => res.json(await service.reply(req.principal, req.params.id, req.body || {}))));
module.exports = { router, hooks };
