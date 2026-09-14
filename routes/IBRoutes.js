// routes/ibRoutes.js
const express = require("express");
const router = express.Router();
const {
  registerIB,
  getAllIBRequests,
  approveIBByEmail,
  rejectIBByEmail,
  referralCode,
  updateIBCommission,
  updateIBCommissionV2,
  updateIBCommissionV3,
  withdrawCommission,
  withdrawCommissionV2,
} = require("../controllers/ibController");

// User side
router.post("/register", registerIB);

// Admin side
router.get("/", getAllIBRequests);
router.put("/:email/approve", approveIBByEmail);
router.put("/:email/reject", rejectIBByEmail);
router.get("/:email", referralCode);


router.post("/update-commission", updateIBCommission); // v1: MoneyPlant-based, writes User.commission - unchanged
router.post("/update-commission-v2", updateIBCommissionV2); // v2: MT5-based (live DealGetPage calls), read-only
router.post("/update-commission-v3", updateIBCommissionV3); // v3: reads from local Deal collection (populated by MT5's webhook), read-only


router.post("/withdrawalIBamount", withdrawCommission); // v1: MoneyPlant-based - unchanged
router.post("/withdrawalIBamountV2", withdrawCommissionV2); // v2: MT5-based, atomic reservation + rollback on failure

module.exports = router;
