const express = require("express");
const {
  requestBrokerOTP,
  verifyBrokerOTP,
  getAllBrokers,
  toggleBrokerMarked,
} = require("../controllers/brokerController");

const router = express.Router();

router.post("/request-otp", requestBrokerOTP); // Step 1
router.post("/verify", verifyBrokerOTP); // Step 2
router.get("/", getAllBrokers); // View verified brokers
router.patch("/:id/mark", toggleBrokerMarked);

module.exports = router;
