const express = require("express");
const router = express.Router();
const {
  register,
  login,
  verifyOTP,
  requestPasswordReset,
  verifyAndResetPassword,

  getAllUsers,
  getUserByEmail,
  uploadProfileImage,
  updateUserProfile,
  updateDocuments,
  updateBankDetails,
  changePassword,
  verifyKyc, // ✅ new controller
  getUnverifiedUsers,
  deleteUser,
  approveBankDetails,
  rejectUserKyc,
  userByReferralCode,
} = require("../controllers/authController");
const upload = require("../middleware/cloudinaryUploader");
const authMiddleware = require('../middleware/authMiddleware');
const { loadPrincipal, requireAdmin, requireOwnerEmail, requireOwnerOrAdminEmail } = require('../middleware/accessControl');
const { createVerificationLink, getVerificationStatus } = require('../controllers/sumsubController');

router.post('/kyc/start', authMiddleware, loadPrincipal, createVerificationLink);
router.get('/kyc/status', authMiddleware, loadPrincipal, getVerificationStatus);
router.get('/admin/session', authMiddleware, loadPrincipal, requireAdmin,
  (req, res) => res.json({ isAdmin: true, user: req.principalUser }));

router.post("/register", register);
router.post("/verify-otp", verifyOTP); // Verifies OTP and finalizes registration
router.post("/login", login);
router.post("/request-reset", requestPasswordReset);
router.post("/verify-reset-otp", verifyAndResetPassword);
router.get('/users', authMiddleware, loadPrincipal, requireAdmin, getAllUsers);
router.get('/user/:email', authMiddleware, loadPrincipal, requireOwnerOrAdminEmail('params', 'email'), getUserByEmail);
router.put(
  "/profile-image/:email",
  authMiddleware, loadPrincipal, requireOwnerEmail('params', 'email'),
  upload.single("profileImage"),
  uploadProfileImage,
);

router.put('/update-profile/:email', authMiddleware, loadPrincipal, requireOwnerEmail('params', 'email'), updateUserProfile);

router.put(
  "/documents/:email",
  authMiddleware, loadPrincipal, requireOwnerEmail('params', 'email'),
  upload.uploadKycDocuments([
    { name: "idProof1Image", maxCount: 1 },
    { name: "idProof1BackImage", maxCount: 1 },
    { name: "idProof2Image", maxCount: 1 },
  ]),
  updateDocuments,
);

router.put('/bank/:email', authMiddleware, loadPrincipal, requireOwnerEmail('params', 'email'), updateBankDetails);
router.patch('/bank-approve/:email', authMiddleware, loadPrincipal, requireAdmin, approveBankDetails);

router.put('/change-password/:email', authMiddleware, loadPrincipal, requireOwnerEmail('params', 'email'), changePassword);
const manualKycDisabled = (req, res, next) => process.env.BDFX_KYC_AUTOMATION_ENABLED === 'true'
  ? res.status(409).json({ message: 'KYC decisions are handled by the verification provider.' }) : next();
router.put('/:email/verify-kyc', authMiddleware, loadPrincipal, requireAdmin, manualKycDisabled, verifyKyc);
router.get('/unverified', authMiddleware, loadPrincipal, requireAdmin, getUnverifiedUsers);
router.delete('/delete/:email', authMiddleware, loadPrincipal, requireAdmin, deleteUser);
router.post('/reject/:email', authMiddleware, loadPrincipal, requireAdmin, manualKycDisabled, rejectUserKyc);
router.get('/userByRef/:referralCode', authMiddleware, loadPrincipal, userByReferralCode);

module.exports = router;
