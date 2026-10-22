const express = require("express");
const { handleFloxyCallback, handleFloxyPayoutCallback } = require("../controllers/payments/floxy.controller");

const router = express.Router();
// Mount this router BEFORE express.json(): the HMAC covers the original bytes.
router.post("/callback", express.raw({ type: "*/*", limit: "256kb" }), handleFloxyCallback);
router.post("/payout-callback", express.raw({ type: "*/*", limit: "256kb" }), handleFloxyPayoutCallback);

module.exports = router;
