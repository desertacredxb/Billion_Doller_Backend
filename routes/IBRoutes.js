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
  getMyClients,
} = require("../controllers/ibController");
const authMiddleware = require('../middleware/authMiddleware');
const { loadPrincipal, requireAdmin, requireOwnerEmail, requireOwnerOrAdminEmail, requireAccountOwner } = require('../middleware/accessControl');

router.use(authMiddleware, loadPrincipal);

// User side
router.post('/register', requireOwnerEmail('body', 'email'), registerIB);

// Admin side
router.get('/', requireAdmin, getAllIBRequests);
router.get('/clients', getMyClients);
const manualIbDisabled = (req, res, next) => process.env.BDFX_KYC_AUTOMATION_ENABLED === 'true'
  ? res.status(409).json({ message: 'IB decisions are handled by the verification workflow.' }) : next();
router.put('/:email/approve', requireAdmin, manualIbDisabled, approveIBByEmail);
router.put('/:email/reject', requireAdmin, manualIbDisabled, rejectIBByEmail);
router.get('/:email', requireOwnerOrAdminEmail('params', 'email'), referralCode);


// Historical recalculation overwrites the ledger, so it requires an operator.
router.post('/update-commission', requireAdmin, updateIBCommission);
router.post('/update-commission-v1', requireAdmin, updateIBCommission);
router.post('/update-commission-v2', requireOwnerOrAdminEmail('body', 'email'), updateIBCommissionV2);
router.post('/update-commission-v3', requireOwnerOrAdminEmail('body', 'email'), updateIBCommissionV3);


router.post('/withdrawalIBamount', requireOwnerEmail('body', 'email'), requireAccountOwner('body', ['accountno', 'accountNo', 'login']), withdrawCommission);
router.post('/withdrawalIBamountV2', requireOwnerEmail('body', 'email'), requireAccountOwner('body', ['accountno', 'accountNo', 'login']), withdrawCommissionV2);

module.exports = router;
