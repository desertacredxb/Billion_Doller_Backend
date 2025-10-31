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
} = require("../controllers/authController");
const upload = require("../middleware/cloudinaryUploader");

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
  uploadProfileImage
);

router.put("/update-profile/:email", updateUserProfile);

router.put(
  "/documents/:email",
  upload.fields([
    { name: "identityFront", maxCount: 1 },
    { name: "identityBack", maxCount: 1 },
    { name: "addressProof", maxCount: 1 },
    { name: "selfieProof", maxCount: 1 },
  ]),
  updateDocuments
);

router.put("/bank/:email", updateBankDetails);
router.patch("/bank-approve/:email", approveBankDetails);

router.put("/change-password/:email", changePassword);
router.put("/:email/verify-kyc", verifyKyc);
router.get("/unverified", getUnverifiedUsers);
router.delete("/delete/:email", deleteUser);
router.post("/reject/:email", rejectUserKyc);

module.exports = router;
