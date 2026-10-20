// routes/ibRoutes.js
const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const { getConnections } = require("../controllers/ibConnectionsController");
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
router.use(auth, access.principal);
router.post("/register", registerIB);
router.get("/connections", getConnections);

// Admin side
router.get("/", access.admin, getAllIBRequests);
router.put("/:email/approve", access.admin, approveIBByEmail);
router.put("/:email/reject", access.admin, rejectIBByEmail);
router.get("/:email", access.emailOwner(), referralCode);


router.post("/update-commission", access.admin, updateIBCommission);
router.post("/update-commission-v2", access.emailOwner("body"), updateIBCommissionV2);
router.post("/update-commission-v3", access.emailOwner("body"), updateIBCommissionV3);


// Client transfers use the atomic MT5 implementation. Keep the legacy
// MoneyPlant mutation off the client surface.
router.post("/withdrawalIBamount", access.admin, withdrawCommission);
router.post("/withdrawalIBamountV2", access.emailOwner("body"), access.accountOwner("body", "accountno"), withdrawCommissionV2);

module.exports = router;
