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
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const adminAuth = require("../controllers/adminAuthController");
const { rateLimit } = require("express-rate-limit");
const adminLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
  message: { message: "Too many administrator sign-in attempts. Please try again later." } });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, skipSuccessfulRequests: true,
  standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many sign-in attempts. Please try again later." } });
const registration = require("../controllers/registrationController");
const registrationLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10,
  standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many registration requests. Please try again later." } });
const registrationCodeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40,
  standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many verification requests. Please try again later." } });

router.get("/registration-options", registration.options);
router.post("/register", registrationLimiter, register);
router.post("/verify-otp", registrationCodeLimiter, verifyOTP);
router.post("/registration/resend-email", registrationCodeLimiter, registration.resendEmail);
router.post("/registration/send-mobile", registrationCodeLimiter, registration.sendMobile);
router.post("/registration/verify-mobile", registrationCodeLimiter, registration.verifyMobile);
router.post("/login", loginLimiter, login);
router.post("/request-reset", loginLimiter, requestPasswordReset);
router.post("/verify-reset-otp", loginLimiter, verifyAndResetPassword);
router.post("/admin/request-code", adminLimiter, adminAuth.requestCode);
router.post("/admin/verify-code", adminLimiter, adminAuth.verifyCode);

router.use(auth, access.principal);
router.get("/admin/session", access.admin, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ email: req.principal.email, fullName: req.principal.fullName, role: req.principal.adminRole, permissions: req.principal.permissions });
});
router.get("/users", access.admin, getAllUsers);
router.get("/user/:email", access.emailOwner(), getUserByEmail);
router.put(
  "/profile-image/:email",
  access.emailOwner(),
  upload.single("profileImage"),
  uploadProfileImage,
);

router.put("/update-profile/:email", access.emailOwner(), updateUserProfile);

router.put(
  "/documents/:email",
  access.emailOwner(),
  upload.uploadKycDocuments([
    { name: "idProof1Image", maxCount: 1 },
    { name: "idProof2Image", maxCount: 1 },
  ]),
  updateDocuments,
);

router.put("/bank/:email", access.emailOwner(), updateBankDetails);
router.patch("/bank-approve/:email", access.admin, approveBankDetails);

router.put("/change-password/:email", access.emailOwner(), changePassword);
router.put("/:email/verify-kyc", access.admin, verifyKyc);
router.get("/unverified", access.admin, getUnverifiedUsers);
router.delete("/delete/:email", access.admin, deleteUser);
router.post("/reject/:email", access.admin, rejectUserKyc);
router.get("/userByRef/:referralCode", access.admin, userByReferralCode);

module.exports = router;
