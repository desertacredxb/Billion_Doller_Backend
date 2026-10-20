const express = require("express");
const {
  requestBrokerOTP,
  verifyBrokerOTP,
  getAllBrokers,
  toggleBrokerMarked,
} = require("../controllers/brokerController");

const router = express.Router();
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");

router.post("/request-otp", requestBrokerOTP); // Step 1
router.post("/verify", verifyBrokerOTP); // Step 2
router.get("/", auth, access.principal, access.admin, getAllBrokers);
router.patch("/:id/mark", auth, access.principal, access.admin, toggleBrokerMarked);

module.exports = router;
