const express = require("express");
const { rateLimit } = require("express-rate-limit");
const auth = require("../middleware/authMiddleware");
const defaultController = require("../controllers/veriffController");

function createRouter({ getStatus, startSession, decisionWebhook } = defaultController) {
  const router = express.Router();
  // Mount this router BEFORE express.json(): the HMAC covers the original bytes.
  router.post("/webhooks/decision", express.raw({ type: "application/json", limit: "256kb" }), decisionWebhook);
  router.get("/status", auth, getStatus);
  router.post("/sessions", auth, rateLimit({
    windowMs: 15 * 60 * 1000, limit: 10,
    keyGenerator: req => String(req.user.id || req.user.userId),
    standardHeaders: "draft-8", legacyHeaders: false,
  }), express.json({ limit: "4kb" }), startSession);
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
