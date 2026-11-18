const router = require("express").Router();
const channels = require("../services/crmOwnerChannels");
const { owner } = require("../middleware/accessControl");
const { CrmError } = require("../services/crm.service");
router.use(owner);
router.use((req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); });
const run = action => async (req, res) => {
  try { await action(req, res); }
  catch (error) {
    if (res.headersSent || res.destroyed) return res.end();
    const status = error instanceof CrmError ? error.status : 502;
    res.status(status).json({ message: error instanceof CrmError ? error.message : "The provider or CRM could not load this activity." });
  }
};
// The provider reports agents on calls separately from agents who are ringing.
router.get("/hashmi/live-status", run(async (_req, res) => {
  const { settings } = require("../services/crmHashmi.service");
  const { userId, token } = settings();
  if (!userId || !token) throw new CrmError(503, "Hashmi live status unavailable.");
  const { data } = await require("axios").post("https://v4-api.deepcall.com/api/v2/Agent/live",
    { userId, token, status: "all" }, { timeout: 8000, maxRedirects: 0, maxContentLength: 1048576 });
  const stats = data?.message;
  const values = [stats?.oCA, stats?.Ring, stats?.lA, stats?.oBA];
  if (data?.status !== "success" || !values.every(n => /^(0|[1-9]\d*)$/.test(String(n)) && Number.isSafeInteger(Number(n)))) {
    throw new CrmError(502, "Hashmi live status unavailable.");
  }
  const [onCall, ringing, signedIn, onBreak] = values.map(Number);
  res.json({ onCall, ringing, signedIn, onBreak, checkedAt: new Date().toISOString() });
}));
router.get("/:channel", run(async (req, res) => res.json(await channels.roster(req.params.channel))));
router.get("/:channel/:agent", run(async (req, res) => res.json(await channels.entries(req.params.channel, req.params.agent, req.query))));
router.get("/:channel/:agent/:id/messages", run(async (req, res) => res.json(await channels.messages(req.params.channel, req.params.agent, req.params.id, req.query.page))));
router.get("/:channel/:agent/:id/audio", run((req, res) => channels.play(req.params.channel, req.params.agent, req.params.id, res)));
module.exports = router;
