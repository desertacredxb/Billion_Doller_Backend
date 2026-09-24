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
const { createVerificationLink, getVerificationStatus } = require('../controllers/sumsubController');

router.post('/kyc/start', authMiddleware, createVerificationLink);
router.get('/kyc/status', authMiddleware, getVerificationStatus);

router.post("/register", register);
router.post("/verify-otp", verifyOTP); // Verifies OTP and finalizes registration
router.post("/login", login);
router.post("/request-reset", requestPasswordReset);
router.post("/verify-reset-otp", verifyAndResetPassword);
router.get("/users", getAllUsers); // ⛔ secure with authMiddleware in production
router.get("/user/:email", getUserByEmail);
router.put(
  "/profile-image/:email",
  upload.single("profileImage"),
  uploadProfileImage,
);

router.put("/update-profile/:email", authMiddleware, updateUserProfile);

router.put(
  "/documents/:email",
  authMiddleware,
  async (req, res, next) => {
    try {
      const User = require('../models/User');
      const account = await User.findById(req.user.id).select('email');
      if (!account || account.email.toLowerCase() !== String(req.params.email).toLowerCase())
        return res.status(403).json({ message: 'This account cannot upload documents for another user.' });
      next();
    } catch (error) { next(error); }
  },
  upload.uploadKycDocuments([
    { name: "idProof1Image", maxCount: 1 },
    { name: "idProof1BackImage", maxCount: 1 },
    { name: "idProof2Image", maxCount: 1 },
  ]),
  updateDocuments,
);

router.put("/bank/:email", updateBankDetails);
router.patch("/bank-approve/:email", approveBankDetails);

router.put("/change-password/:email", changePassword);
const manualKycDisabled = (req, res, next) => process.env.BDFX_KYC_AUTOMATION_ENABLED === 'true'
  ? res.status(409).json({ message: 'KYC decisions are handled by the verification provider.' }) : next();
router.put("/:email/verify-kyc", manualKycDisabled, verifyKyc);
router.get("/unverified", getUnverifiedUsers);
router.delete("/delete/:email", deleteUser);
router.post("/reject/:email", manualKycDisabled, rejectUserKyc);
router.get("/userByRef/:referralCode", userByReferralCode);

module.exports = router;
