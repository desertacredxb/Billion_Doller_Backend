const express = require("express");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const service = require("../services/emailMarketing.service");
function createRouter({ authentication = auth, principal = access.principal, owner = access.owner, campaign = service } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" }); next(); });
  // GET never changes consent: mail security scanners routinely follow links.
  router.get("/unsubscribe", (_req, res) => {
    res.set("Content-Security-Policy", "default-src 'none'; form-action 'self'; frame-ancestors 'none'");
    res.type("html").send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>BDFX email preferences</title><h1>Unsubscribe from BDFX email updates</h1><p>Choose below to stop marketing emails. Account and security emails are unaffected.</p><form method="post"><button type="submit">Unsubscribe</button></form></html>');
  });
  router.post("/unsubscribe", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    try {
      if (!await campaign.unsubscribe(req.query.token)) return res.status(400).type("text").send("This unsubscribe link is invalid. You can also change email preferences in your account settings.");
      return res.type("text").send("You have unsubscribed from BDFX marketing emails.");
    } catch { return res.status(503).type("text").send("Unable to save your preference. Please try again or contact support@billiondollarfx.com."); }
  });
  router.get("/report", authentication, principal, owner, async (_req, res) => {
    try { res.json(await campaign.status()); } catch { res.status(503).json({ message: "Email marketing status is temporarily unavailable." }); }
  });
  router.patch("/state", authentication, principal, owner, async (req, res) => {
    if (typeof req.body?.paused !== "boolean" || Object.keys(req.body).some(k => k !== "paused")) return res.status(400).json({ message: "Choose pause or resume." });
    try { res.json(await campaign.setPaused(req.body.paused)); } catch { res.status(409).json({ message: "Unable to change delivery. Confirm the mailbox sending allowance and campaign configuration." }); }
  });
  const clientOnly = (req, res, next) => req.principal?.isAdmin ? res.status(403).json({ message: "Use your client account to change your own email preferences." }) : next();
  router.get("/preferences", authentication, principal, clientOnly, async (req, res) => {
    try { res.json(await campaign.getPreference(req.principal.id)); } catch { res.status(503).json({ message: "Email preferences are temporarily unavailable." }); }
  });
  router.put("/preferences", authentication, principal, clientOnly, async (req, res) => {
    if (typeof req.body?.subscribed !== "boolean" || Object.keys(req.body).some(k => k !== "subscribed")) return res.status(400).json({ message: "Choose an email preference." });
    try { res.json(await campaign.preference(req.principal.id, req.body.subscribed)); } catch { res.status(503).json({ message: "Unable to save email preferences." }); }
  });
  return router;
}
module.exports = createRouter();
module.exports.createRouter = createRouter;
