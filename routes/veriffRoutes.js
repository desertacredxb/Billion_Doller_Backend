const express = require("express");
const { rateLimit } = require("express-rate-limit");
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const defaultController = require("../controllers/veriffController");

function createRouter({ getStatus, syncStatus = defaultController.syncStatus, updateDetails = defaultController.updateDetails, startSession, decisionWebhook } = defaultController) {
  const router = express.Router();
  // Mount this router BEFORE express.json(): the HMAC covers the original bytes.
  router.post("/webhooks/decision", express.raw({ type: "application/json", limit: "256kb" }), decisionWebhook);
  router.get("/status", auth, getStatus);
  router.post("/admin/sync/:userId", auth, access.principal, access.owner, rateLimit({
    windowMs: 15 * 60 * 1000, limit: 20, keyGenerator: req => String(req.principal.id),
    standardHeaders: "draft-8", legacyHeaders: false,
  }), express.json({ limit: "2kb" }), syncStatus);
  router.patch("/details", auth, express.json({ limit: "4kb" }), updateDetails);
  router.post("/sessions", auth, rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10,
    keyGenerator: req => String(req.user.id || req.user.userId),
    standardHeaders: "draft-8", legacyHeaders: false,
  }), express.json({ limit: "4kb" }), startSession);
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
