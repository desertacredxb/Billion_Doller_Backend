const express = require("express");
const rateLimit = require("express-rate-limit");

const {
  handleChat,
  handleReset,
  handleHistory,
} = require("../controllers/ai.controller");

const router = express.Router();

const aiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: "Too many requests generated. Try again later.",
  },
});

router.post("/chat", aiRateLimiter, handleChat);
router.post("/reset", handleReset);
router.get("/history", handleHistory);

module.exports = router;