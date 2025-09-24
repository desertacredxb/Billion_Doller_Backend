const Broker = require("../models/Broker");
const sendEmail = require("../utils/sendEmail");

// Utility: Generate 6-digit OTP
const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// Step 1: Send OTP to email
exports.requestBrokerOTP = async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required" });

  const otp = generateOTP();
  const otpExpires = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

  try {
    let broker = await Broker.findOne({ email });

    if (!broker) {
      broker = new Broker({ email, otp, otpExpires });
    } else {
      broker.otp = otp;
      broker.otpExpires = otpExpires;
      broker.isVerified = false; // reset verification if retrying
      broker.expiresAt = new Date(Date.now() + 10 * 60 * 1000); // refresh TTL
    }

    await broker.save();

    await sendEmail({
      to: email,
      subject: "Broker Verification OTP",
      html: `<p>Your OTP is <strong>${otp}</strong>. It will expire in 5 minutes.</p>`,
    });

    res.status(200).json({ message: "OTP sent to email" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error sending OTP", error: error.message });
  }
};

// Step 2: Verify OTP and save broker details
exports.verifyBrokerOTP = async (req, res) => {
  const { firstName, lastName, email, phone, message, otp } = req.body;

  if (!email || !otp || !firstName || !lastName || !phone) {
    return res.status(400).json({ message: "Please fill all required fields" });
  }

  try {
    const broker = await Broker.findOne({ email });

    if (!broker) return res.status(404).json({ message: "Broker not found" });

    if (!broker.otp || !broker.otpExpires || new Date() > broker.otpExpires) {
      return res
        .status(400)
        .json({ message: "OTP expired. Please request a new one." });
    }

    if (broker.otp !== otp)
      return res.status(400).json({ message: "Invalid OTP" });

    broker.firstName = firstName;
    broker.lastName = lastName;
    broker.phone = phone;
    broker.message = message;
    broker.isVerified = true;
    broker.otp = null;
    broker.otpExpires = null;

    // ✅ Prevent TTL deletion for verified brokers
    broker.expiresAt = undefined;

    await broker.save();

    res.status(200).json({ message: "Broker verified and saved successfully" });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Verification failed", error: error.message });
  }
};

// Step 3: Get all verified brokers
exports.getAllBrokers = async (req, res) => {
  try {
    const brokers = await Broker.find({ isVerified: true }).sort({
      createdAt: -1,
    });

    res.status(200).json(brokers);
  } catch (error) {
    res
      .status(500)
      .json({ message: "Failed to fetch brokers", error: error.message });
  }
};

exports.toggleBrokerMarked = async (req, res) => {
  try {
    const { id } = req.params;

    const broker = await Broker.findById(id);
    if (!broker) {
      return res.status(404).json({ message: "Broker not found" });
    }

    broker.marked = !broker.marked; // toggle true/false
    await broker.save();

    res.json({ success: true, marked: broker.marked });
  } catch (error) {
    res
      .status(500)
      .json({ message: "Error updating broker", error: error.message });
  }
};
