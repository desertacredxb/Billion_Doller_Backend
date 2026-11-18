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
router.get("/:channel", run(async (req, res) => res.json(await channels.roster(req.params.channel))));
router.get("/:channel/:agent", run(async (req, res) => res.json(await channels.entries(req.params.channel, req.params.agent, req.query))));
router.get("/:channel/:agent/:id/messages", run(async (req, res) => res.json(await channels.messages(req.params.channel, req.params.agent, req.params.id, req.query.page))));
router.get("/:channel/:agent/:id/audio", run((req, res) => channels.play(req.params.channel, req.params.agent, req.params.id, res)));
module.exports = router;
