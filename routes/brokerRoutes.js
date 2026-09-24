const express = require("express");
const {
  requestBrokerOTP,
  verifyBrokerOTP,
  getAllBrokers,
  toggleBrokerMarked,
} = require("../controllers/brokerController");

const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { loadPrincipal, requireAdmin } = require("../middleware/accessControl");

router.post("/request-otp", requestBrokerOTP); // Step 1
router.post("/verify", verifyBrokerOTP); // Step 2
router.get("/", auth, loadPrincipal, requireAdmin, getAllBrokers); // View verified brokers
router.patch("/:id/mark", auth, loadPrincipal, requireAdmin, (req, res, next) => {
  if (!/^[a-fA-F0-9]{24}$/.test(req.params.id)) {
    return res.status(400).json({ message: "Invalid broker ID." });
  }
  next();
}, toggleBrokerMarked);

module.exports = router;
