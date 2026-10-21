const User = require("../models/User");
const Account = require("../models/account.model");
const IB = require("../models/Broker.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { randomInt } = require("node:crypto");
const sendEmail = require("../utils/sendEmail");
const { sendPasswordResetOtpEmail } = require("../utils/Email");
const axios = require("axios");
const { normalizeEmail, emailPattern, normalizePhone } = require("../utils/registrationIdentity");

const registration = require("./registrationController");
exports.register = registration.register;
exports.verifyOTP = registration.verifyOTP;

exports.login = async (req, res) => {
  const { password } = req.body || {};
  const email = normalizeEmail(req.body?.email);

  try {
    if (!email || typeof password !== "string") return res.status(400).json({ message: "Invalid email or password" });
    const user = await User.findOne({ email: emailPattern(email) });
    if (!user)
      return res.status(400).json({ message: "Invalid email or password" });

    // 🚫 Block login if OTP is still pending
    if (user.otp) {
      return res.status(403).json({
        message: "Please verify your OTP before logging in.",
      });
    }

    if (!user.isVerified) {
      return res
        .status(403)
        .json({ message: "Please verify your account via OTP." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid email or password" });

    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

exports.requestPasswordReset = async (req, res) => {
  const email = normalizeEmail(req.body?.email);

  try {
    if (!email) return res.status(400).json({ message: "Enter a valid email address." });
    const user = await User.findOne({ email: emailPattern(email) });
    if (!user) return res.status(404).json({ message: "User not found" });

    const otp = randomInt(100000, 1000000).toString();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    user.resetOtp = otp;
    user.resetOtpExpires = otpExpires;
    await user.save();

    await sendPasswordResetOtpEmail({
      email: user.email,
      name: user.fullName,
      otp,
    });

    // Send WhatsApp
    // await sendWhatsAppOTP(user.phone, otp);

    res.status(200).json({ message: "OTP sent to email" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to send reset OTP", error: err.message });
  }
};

exports.verifyAndResetPassword = async (req, res) => {
  const { otp, newPassword } = req.body || {};
  const email = normalizeEmail(req.body?.email);

  try {
    if (!email) return res.status(400).json({ message: "Enter a valid email address." });
    const user = await User.findOne({ email: emailPattern(email) });
    if (!user || !user.resetOtp || !user.resetOtpExpires) {
      return res.status(400).json({ message: "Invalid request or OTP" });
    }

    // Check if OTP expired
    if (new Date() > user.resetOtpExpires) {
      return res.status(400).json({ message: "OTP expired" });
    }

    // Check if OTP matches
    if (user.resetOtp !== otp) {
      return res.status(400).json({ message: "Incorrect OTP" });
    }

    // Hash and update the password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;

    // Clear OTP fields
    user.resetOtp = null;
    user.resetOtpExpires = null;

    await user.save();

    res.status(200).json({ message: "Password reset successful" });
  } catch (err) {
    res.status(500).json({
      message: "Error resetting password",
      error: err.message,
    });
  }
};

exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find()
      .select("-password -otp -otpExpires -resetOtp -resetOtpExpires")
      .sort({ createdAt: -1 }); // ✅ newest first

    res.set("Cache-Control", "no-store");
    res.json(await require("../services/adminUsers.service").withReferrerNames(users));
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to fetch users", error: err.message });
  }
};

exports.getUserByEmail = async (req, res) => {
  const { email } = req.params;

  try {
    const user = await User.findOne({ email })
      .select("-password -otp -otpExpires -resetOtp -resetOtpExpires")
      .populate("accounts"); // uses virtual populate

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to fetch user", error: err.message });
  }
};

exports.uploadProfileImage = async (req, res) => {
  try {
    const { email } = req.params;

    if (!req.file) {
      return res.status(400).json({ message: "No file received in request." });
    }

    const profileImage = req.file.path;

    const user = await User.findOneAndUpdate(
      { email },
      { profileImage },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ success: true, user });
  } catch (err) {
    console.error("Backend error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.updateUserProfile = async (req, res) => {
  try {
    const { email } = req.params;
    const existing = await User.findOne({ email });
    if (!existing) return res.status(404).json({ message: "User not found" });
    if (String(existing._id) !== String(req.user.id || req.user.userId)) {
      return res.status(403).json({ message: "You can only update your own profile." });
    }
    // Never accept approval flags, credentials, or provider session data from a profile form.
    const allowed = ["fullName", "gender", "accountType", "address", "country", "state", "city", "postalCode", "phone"];
    const updateFields = Object.fromEntries(allowed
      .filter(key => Object.hasOwn(req.body, key) && typeof req.body[key] === "string")
      .map(key => [key, req.body[key]]));
    if (Object.hasOwn(updateFields, "phone")) {
      const phone = normalizePhone(updateFields.phone);
      if (!phone) return res.status(400).json({ message: "Enter a valid international mobile number." });
      if (phone !== normalizePhone(existing.phone)) {
        return res.status(409).json({ message: "Please contact support to change and reverify your mobile number." });
      }
      delete updateFields.phone;
    }
    if (existing.kycProvider === "veriff") {
      if ((updateFields.phone && normalizePhone(updateFields.phone) !== normalizePhone(existing.phone)) ||
          (updateFields.country && updateFields.country !== existing.country)) {
        return res.status(409).json({ message: "Please contact support to change your mobile number or country after identity verification has started." });
      }
      delete updateFields.phone;
      delete updateFields.country;
    }

    const user = await User.findOneAndUpdate(
      { email },
      { $set: updateFields },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.status(200).json({ success: true, user });
  } catch (err) {
    console.error("Update profile error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.updateDocuments = async (req, res) => {
  try {
    const { email } = req.params;
    const {
      idProof1DocType,
      idProof1DocNumber,
      idProof2DocType,
      idProof2DocNumber,
    } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    if (user.kycProvider === "veriff") {
      return res.status(409).json({ message: "Please complete identity verification with Veriff." });
    }
    if (user.hasSubmittedDocuments) {
      return res.status(400).json({
        success: false,
        message: "Documents already submitted. Resubmission is not allowed.",
      });
    }

    const idProof1Image = req.files?.idProof1Image?.[0]?.path;
    const idProof2Image = req.files?.idProof2Image?.[0]?.path;

    // ID proof 1 is mandatory — all three fields required together.
    if (!idProof1DocType || !idProof1DocNumber || !idProof1Image) {
      return res.status(400).json({
        success: false,
        message:
          "ID Proof 1 is required: document type, document number, and image.",
      });
    }

    // ID proof 2 is optional, but if any field is supplied all three must be.
    const idProof2Fields = [idProof2DocType, idProof2DocNumber, idProof2Image];
    const idProof2Provided = idProof2Fields.some(Boolean);
    if (idProof2Provided && !idProof2Fields.every(Boolean)) {
      return res.status(400).json({
        success: false,
        message:
          "ID Proof 2 is optional, but if provided it needs a document type, document number, and image.",
      });
    }

    const updateFields = {
      idProof1: {
        docType: idProof1DocType,
        docNumber: idProof1DocNumber,
        image: idProof1Image,
      },
      hasSubmittedDocuments: true,
      // A now-removed bug used to force isKycVerified true on a plain GET,
      // so some accounts already carry a stale true from before they ever
      // submitted anything. Explicitly reset it to false on every fresh
      // submission so a new upload always lands in "pending review" rather
      // than inheriting that stale value - admin approval (verifyKyc) is
      // what should flip this back to true.
      isKycVerified: false,
    };

    if (idProof2Provided) {
      updateFields.idProof2 = {
        docType: idProof2DocType,
        docNumber: idProof2DocNumber,
        image: idProof2Image,
      };
    }

    const updatedUser = await User.findOneAndUpdate(
      { email },
      { $set: updateFields },
      { new: true },
    );

    res.status(200).json({
      success: true,
      message: "Documents submitted successfully",
      user: updatedUser,
    });
  } catch (err) {
    console.error("Update failed:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// 3. Update Bank Details by email
exports.updateBankDetails = async (req, res) => {
  try {
    const { email } = req.params;
    const {
      accountHolderName,
      accountNumber,
      ifscCode,
      iban,
      bankName,
      bankAddress,
    } = req.body;

    // Save details in pendingBankDetails
    const user = await User.findOneAndUpdate(
      { email },
      {
        $set: {
          pendingBankDetails: {
            accountHolderName,
            accountNumber,
            ifscCode,
            iban,
            bankName,
            bankAddress,
          },
          bankApprovalStatus: "pending",
        },
      },
      { new: true },
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    // ✅ Send email to admin
    await sendEmail({
      to: "support@billiondollarfx.com",
      subject: "⚠️ Bank Details Update - Pending Approval",
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
          <h2 style="color: #e67e22;">Bank Details Update Alert</h2>
          
          <p><strong>${user.fullName}</strong> (${user.email
        }) has updated their bank details.</p>
          
          <p><strong>Updated Bank Information (Pending Approval):</strong></p>
          <ul>
            <li><strong>Account Holder Name:</strong> ${accountHolderName}</li>
            <li><strong>Account Number:</strong> ${accountNumber}</li>
            <li><strong>IFSC Code:</strong> ${ifscCode || "N/A"}</li>
            <li><strong>IBAN:</strong> ${iban || "N/A"}</li>
            <li><strong>Bank Name:</strong> ${bankName}</li>
            <li><strong>Bank Address:</strong> ${bankAddress}</li>
          </ul>

          <p>
            ✅ Next Step: Please verify these details in the admin dashboard.<br/>
            Once confirmed, approve them for transactions.<br/>
            If necessary, contact the user directly for confirmation.
          </p>
          
          <br/>
          <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
        </div>
      `,
    });

    res.status(200).json({
      success: true,
      message: "Bank details submitted for approval & admin notified",
      user,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { email } = req.params;
    const { oldPassword, newPassword, confirmPassword } = req.body;

    if (!oldPassword || !newPassword || !confirmPassword) {
      return res
        .status(400)
        .json({ success: false, message: "All fields are required." });
    }

    if (newPassword !== confirmPassword) {
      return res
        .status(400)
        .json({ success: false, message: "Passwords do not match." });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return res
        .status(401)
        .json({ success: false, message: "Old password is incorrect." });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    res
      .status(200)
      .json({ success: true, message: "Password changed successfully." });
  } catch (err) {
    console.error("Password change failed:", err);
    res.status(500).json({ success: false, message: "Internal server error." });
  }
};

exports.verifyKyc = async (req, res) => {
  try {
    const { email } = req.params;
    const { status } = req.body; // true = approve, false = reject
    const managedUser = await User.findOne({ email });
    if (managedUser?.kycProvider === "veriff") {
      return res.status(409).json({ message: "Identity verification is managed by Veriff. Please review this client in Veriff." });
    }

    if (status) {
      // Guard against re-creating the isKycVerified-without-documents state
      // a past bug used to produce (see the comment in updateDocuments) -
      // only allow approval once the user has actually submitted documents.
      const existing = await User.findOne({ email });
      if (!existing) {
        return res.status(404).json({ message: "User not found" });
      }
      if (!existing.hasSubmittedDocuments) {
        return res.status(400).json({
          message: "Cannot verify KYC: user has not submitted documents yet",
        });
      }
    }

    const user = await User.findOneAndUpdate(
      { email },
      { isKycVerified: status },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await sendEmail({
      to: user.email,
      subject: `Your KYC has been ${status ? "approved ✅" : "rejected ❌"}`,
      html: `
        <p>Hi ${user.fullName},</p>
        <p>Your KYC verification has been <b>${status ? "approved" : "rejected"
        }</b>.</p>
        <p>${status
          ? "You can now access all features of your account."
          : "Please contact support for further assistance."
        }</p>
       
        <p>Thank you</p>
      `,
    });

    res.json({
      message: `User KYC ${status ? "approved ✅" : "rejected ❌"}`,
      user,
    });
  } catch (error) {
    console.error("Error verifying KYC:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

exports.getUnverifiedUsers = async (req, res) => {
  try {
    const users = await User.find({ isKycVerified: false });
    res.json(users);
  } catch (error) {
    console.error("Error fetching unverified users:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// Delete a user by email
exports.deleteUser = async (req, res) => {
  try {
    const { email } = req.params;

    const user = await User.findOneAndDelete({ email });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await sendEmail({
      to: user.email,
      subject: `KYC Verification Rejected - Action Required`,
      html: `
        <p>Dear ${user.fullName},</p>
        <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_Account_Rejected_Due_to_KYC_exjpm2.jpg" 
         alt="Welcome Image" style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />

        <p>We regret to inform you that your KYC verification process could not be completed because the required documents were not uploaded within the stipulated 3-day timeframe as part of our compliance procedure.</p>

        <p>As a result, your account has been automatically rejected and deleted from our system for security and regulatory compliance purposes.</p>

        <p>If you wish to use our services in the future, you are welcome to register a new account and follow the KYC verification process from the beginning.</p>

        <p>For further assistance, please contact our support team.</p>

        <p>Thank you for your understanding.</p>

        <p>Best regards,<br/>The Compliance Team</p>
      `,
    });

    res.json({
      message: `User with email ${email} deleted due to incomplete KYC within 3-day deadline 🚮`,
      user,
    });
  } catch (error) {
    console.error("Error deleting user:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
};
exports.approveBankDetails = async (req, res) => {
  try {
    const { email } = req.params;
    const { approve } = req.body; // true = approve, false = reject

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const pending = user.pendingBankDetails;

    if (approve) {
      if (!pending || Object.keys(pending).length === 0) {
        return res.status(400).json({
          success: false,
          message: "No pending bank details to approve",
        });
      }

      user.accountHolderName = pending.accountHolderName;
      user.accountNumber = pending.accountNumber;
      user.ifscCode = pending.ifscCode;
      user.iban = pending.iban;
      user.bankName = pending.bankName;
      user.bankAddress = pending.bankAddress;
      user.bankApprovalStatus = "approved";
      user.pendingBankDetails = {}; // clear pending
    } else {
      user.bankApprovalStatus = "rejected";
      user.pendingBankDetails = {}; // clear pending
    }

    // Skip validation to avoid unrelated field errors
    await user.save({ validateBeforeSave: false });

    res.status(200).json({
      success: true,
      message: `Bank details ${approve ? "approved" : "rejected"}`,
      user,
    });
  } catch (err) {
    console.error("Error approving bank details:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Reject user KYC manually (by admin)
exports.rejectUserKyc = async (req, res) => {
  try {
    const { email } = req.params;

    // 1️⃣ Find the user
    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    if (user.kycProvider === "veriff") {
      return res.status(409).json({ message: "Identity verification is managed by Veriff. Please review this client in Veriff." });
    }
    // 2️⃣ Update KYC status
    user.isKycVerified = false; // mark unverified
    user.hasSubmittedDocuments = false; // reset submission flag
    await user.save();

    // 3️⃣ Send rejection email
    await sendEmail({
      to: user.email,
      subject: "KYC Verification Rejected - Please Re-upload Documents",
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #d9534f;">KYC Verification Rejected</h2>
          <p>Dear ${user.fullName || "User"},</p>
          <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/Your_Account_Rejected_Due_to_KYC_exjpm2.jpg" 
               alt="KYC Rejected" 
               style="width:600px; max-width:100%; height:auto; display:block; margin-top:20px;" />
          
          <p>We regret to inform you that your submitted KYC documents could not be verified successfully.</p>
          <p>Please log in to your account and re-upload valid and clear documents for verification.</p>
          <p>Once you re-upload, our team will review your documents within 24–48 hours.</p>
          
          <br/>
          <p>Best regards,<br/>The Compliance Team</p>
        </div>
      `,
    });

    // 4️⃣ Respond to admin
    res.json({
      success: true,
      message: `KYC for ${email} has been rejected and the user has been notified.`,
      user: {
        email: user.email,
        fullName: user.fullName,
        isKycVerified: user.isKycVerified,
      },
    });
  } catch (error) {
    console.error("❌ Error rejecting user KYC:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
};

exports.userByReferralCode = async (req, res) => {
  try {
    const { referralCode } = req.params;

    if (!referralCode) {
      return res.status(400).json({ message: "Referral code is required." });
    }

    // Step 1️⃣: Find the IB by referral code
    const ib = await IB.findOne({ referralCode });
    if (!ib) {
      return res
        .status(404)
        .json({ message: "IB not found with this referral code." });
    }

    // Step 2️⃣: Find the User by the IB's email
    const user = await User.findOne({ email: ib.email });
    if (!user) {
      return res.status(404).json({ message: "User not found for this IB." });
    }

    // Step 3️⃣: Return both IB and User data
    return res.status(200).json({
      success: true,
      ib,
      user,
    });
  } catch (error) {
    console.error("Error fetching user by referral code:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching user by referral code.",
      error: error.message,
    });
  }
};
