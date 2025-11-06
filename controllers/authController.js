const User = require("../models/User");
const Account = require("../models/account.model");
const IB = require("../models/Broker.model");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const sendEmail = require("../utils/sendEmail");
// const sendWhatsAppOTP = require("../utils/sendWhatsAppOTP");

exports.register = async (req, res) => {
  const {
    fullName,
    email,
    phone,
    nationality,
    state,
    city,
    password,
    referralCode,
  } = req.body;

  try {
    // 🔍 Check email
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      return res.status(400).json({ message: "Email already registered" });
    }

    // 🔍 Check phone
    const existingPhone = await User.findOne({ phone });
    if (existingPhone) {
      return res
        .status(400)
        .json({ message: "Phone number already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 mins

    const user = new User({
      fullName,
      email,
      phone,
      nationality,
      state,
      city,
      password: hashedPassword,
      referralCode,
      otp,
      otpExpires,
    });

    await user.save();

    await sendEmail({
      to: email,
      subject: "Verify Your Email Address - OTP Code",
      html: `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2 style="color: #2c3e50;">Email Verification Required</h2>
      <p>Dear ${fullName || "User"},</p>
      <p>Thank you for registering with us. To complete your sign-up, please use the One-Time Password (OTP) below to verify your email address:</p>
      
      <p style="font-size: 20px; font-weight: bold; color: #2c3e50; text-align: center; margin: 20px 0;">
        ${otp}
      </p>
      
      <p>This OTP is valid for <strong>5 minutes</strong>. Please do not share this code with anyone for security reasons.</p>
      
      <p>If you did not initiate this request, you can safely ignore this email.</p>
      
      <br/>
      <p>Best Regards,<br/>The Support Team</p>
    </div>
  `,
    });

    // await sendWhatsAppOTP(phone, otp);

    res.status(200).json({ message: "OTP sent to email" });
  } catch (err) {
    res.status(500).json({ message: "Error sending OTP", error: err.message });
  }
};

exports.verifyOTP = async (req, res) => {
  const { email, otp } = req.body;

  try {
    const user = await User.findOne({ email });

    if (!user) return res.status(400).json({ message: "User not found" });

    if (!user.otp || !user.otpExpires || new Date() > user.otpExpires)
      return res
        .status(400)
        .json({ message: "OTP expired. Please register again." });

    if (user.otp !== otp)
      return res.status(400).json({ message: "Invalid OTP" });

    // OTP matched – now activate
    user.isVerified = true;
    user.otp = null;
    user.otpExpires = null;

    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });
    await sendEmail({
      to: user.email,
      subject: "Welcome to Billion Dollar FX 🎉",
      html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2 style="color: #00CFFF;">Welcome, ${user.fullName}!</h2>
      
      <p>We’re excited to have you on board with <strong>Billion Dollar FX</strong>.</p>
      
      <p>Your account has been successfully created. You can now log in and start exploring the platform.</p>
      
      <p style="color:#d9534f; font-weight:bold;">
        🔔 To activate your account fully, please go to <strong>Settings</strong> and upload your documents and bank details for KYC verification.
      </p>
      
      <img src="https://res.cloudinary.com/dqrlkbsdq/image/upload/v1758094566/welcome_to_billiondollarfx_bn6rs2.jpg" 
           alt="Welcome Image" style="width:600px; max-width:100%; height:auto; display:block; margin:20px auto;" />
      
      <p>If you have any questions or need assistance, our support team is here to help.</p>
      
      <p>We look forward to seeing you succeed in your trading journey 🚀</p>
      
      <br/>
      <p>Best Regards,<br/><strong>The Billion Dollar FX Team</strong></p>
    </div>
  `,
    });

    await sendEmail({
      to: "support@billiondollarfx.com",
      subject: "🔔 New User Registered on Billion Dollar FX",
      html: `
    <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
      <h2 style="color: #00CFFF;">New User Registration Alert</h2>
      
      <p>A new user has just registered on <strong>Billion Dollar FX</strong>.</p>
      
      <p><strong>User Details:</strong></p>
      <ul>
        <li><strong>Full Name:</strong> ${user.fullName}</li>
        <li><strong>Email:</strong> ${user.email}</li>
        <li><strong>Phone:</strong> ${user.phone || "Not Provided"}</li>
        <li><strong>Registration Date:</strong> ${new Date().toLocaleString()}</li>
      </ul>
      
      <p>
        Please log in to the admin panel to verify their account.  
        If the user has not yet uploaded their <strong>documents</strong> or <strong>bank details</strong>,  
        kindly reach out to them and request the necessary information for KYC verification.
      </p>
      
      <p style="margin-top:20px;">
        ✅ Next Step: <strong>Check user’s profile in the admin dashboard.</strong>
      </p>
      
      <br/>
      <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
    </div>
  `,
    });

    res.status(201).json({
      message: "User verified & registered",
      token,
      user: user.fullName,
      user: user.email,
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "OTP verification failed", error: err.message });
  }
};

exports.login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
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
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    user.resetOtp = otp;
    user.resetOtpExpires = otpExpires;
    await user.save();

    await sendEmail({
      to: email,
      subject: "Password Reset Request - OTP Code",
      html: `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <h2 style="color: #2c3e50;">Password Reset Verification</h2>
      <p>Dear ${user.fullName || "User"},</p>
      <p>We received a request to reset the password for your account. To proceed, please use the One-Time Password (OTP) provided below:</p>
      
      <p style="font-size: 20px; font-weight: bold; color: #2c3e50; text-align: center; margin: 20px 0;">
        ${otp}
      </p>
      
      <p>This OTP is valid for <strong>5 minutes</strong>. Do not share this code with anyone for security purposes.</p>
      
      <p>If you did not request a password reset, please ignore this email. Your account remains secure.</p>
      
      <br/>
      <p>Best Regards,<br/>The Support Team</p>
    </div>
  `,
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
  const { email, otp, newPassword } = req.body;

  try {
    const user = await User.findOne({ email });
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

    res.json(users);
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
      { new: true }
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
    const updateFields = req.body;

    const user = await User.findOneAndUpdate(
      { email },
      { $set: updateFields },
      { new: true }
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

    const user = await User.findOne({ email });

    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found." });
    }

    if (user.hasSubmittedDocuments) {
      return res.status(400).json({
        success: false,
        message: "Documents already submitted. Resubmission is not allowed.",
      });
    }

    const identityFront = req.files?.identityFront?.[0]?.path;
    const identityBack = req.files?.identityBack?.[0]?.path;
    const addressProof = req.files?.addressProof?.[0]?.path;
    const selfieProof = req.files?.selfieProof?.[0]?.path;

    const updateFields = {};
    if (identityFront) updateFields.identityFront = identityFront;
    if (identityBack) updateFields.identityBack = identityBack;
    if (addressProof) updateFields.addressProof = addressProof;
    if (selfieProof) updateFields.selfieProof = selfieProof;

    if (Object.keys(updateFields).length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No files uploaded" });
    }

    updateFields.hasSubmittedDocuments = true;

    const updatedUser = await User.findOneAndUpdate(
      { email },
      { $set: updateFields },
      { new: true }
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
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    // ✅ Send email to admin
    await sendEmail({
      to: "support@billiondollarfx.com",
      subject: "⚠️ Bank Details Update - Pending Approval",
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
          <h2 style="color: #e67e22;">Bank Details Update Alert</h2>
          
          <p><strong>${user.fullName}</strong> (${
        user.email
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

    const user = await User.findOneAndUpdate(
      { email },
      { isKycVerified: status },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await sendEmail({
      to: user.email,
      subject: `Your KYC has been ${status ? "approved ✅" : "rejected ❌"}`,
      html: `
        <p>Hi ${user.fullName},</p>
        <p>Your KYC verification has been <b>${
          status ? "approved" : "rejected"
        }</b>.</p>
        <p>${
          status
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
