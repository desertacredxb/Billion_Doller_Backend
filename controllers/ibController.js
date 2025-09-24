// controllers/ibController.js
const IB = require("../models/Broker.model");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");

/**
 * 📌 Register IB Request (User Side)
 */
const registerIB = async (req, res) => {
  try {
    const {
      email,
      existingClientBase,
      offerEducation,
      expectedClientsNext3Months,
      expectedCommissionDirect,
      expectedCommissionSubIB,
      yourShare,
      clientShare,
    } = req.body;

    // check if user exists
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // check if already requested
    const existingIB = await IB.findOne({ email });
    if (existingIB) {
      return res.status(400).json({ message: "IB request already submitted" });
    }

    const newIB = new IB({
      email,
      existingClientBase,
      offerEducation,
      expectedClientsNext3Months,
      expectedCommissionDirect,
      expectedCommissionSubIB,
      yourShare,
      clientShare,
    });

    await newIB.save();

    // ✅ Send email to admin
    await sendEmail({
      to: "support@billiondollarfx.com",
      subject: "🚀 New IB Request Submitted",
      html: `
        <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.6;">
          <h2 style="color: #1abc9c;">New Introducing Broker Request</h2>
          <p>A user has submitted a new IB request. Please review and approve in the admin dashboard.</p>
          
          <p><strong>User Details:</strong></p>
          <ul>
            <li><strong>Name:</strong> ${user.fullName || "N/A"}</li>
            <li><strong>Email:</strong> ${email}</li>
          </ul>

          <p><strong>IB Details:</strong></p>
          <ul>
            <li><strong>Existing Client Base:</strong> ${existingClientBase}</li>
            <li><strong>Offer Education:</strong> ${offerEducation}</li>
            <li><strong>Expected Clients (Next 3 Months):</strong> ${expectedClientsNext3Months}</li>
            <li><strong>Expected Commission (Direct):</strong> ${expectedCommissionDirect}</li>
            <li><strong>Expected Commission (Sub IB):</strong> ${expectedCommissionSubIB}</li>
            <li><strong>Your Share:</strong> ${yourShare}</li>
            <li><strong>Client Share:</strong> ${clientShare}</li>
          </ul>

          <p>✅ Next Step: Please approve this IB request in the dashboard and contact the user if necessary.</p>

          <br/>
          <p>Best Regards,<br/><strong>Billion Dollar FX System</strong></p>
        </div>
      `,
    });

    res
      .status(201)
      .json({ message: "IB request submitted successfully", newIB });
  } catch (err) {
    console.error("❌ Error submitting IB request:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * 📌 Get All IB Requests (Admin Side)
 */
const getAllIBRequests = async (req, res) => {
  try {
    const ibRequests = await IB.find().sort({ createdAt: -1 });
    res.json(ibRequests);
  } catch (err) {
    console.error("❌ Error fetching IB requests:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * 📌 Approve IB Request (Admin Side)
 */
const approveIBByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    const ib = await IB.findOne({ email });
    if (!ib) return res.status(404).json({ message: "IB request not found" });

    // generate referral code
    const referralCode =
      "IB" + Math.random().toString(36).substring(2, 8).toUpperCase();

    // update IB
    ib.status = "approved";
    ib.referralCode = referralCode;
    await ib.save();

    // update user
    const user = await User.findOneAndUpdate({ email }, { isApprovedIB: true });
    // 🔹 Send approval email
    await sendEmail({
      to: user.email,
      subject: "Your Introducing Broker Application Approved",
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #2c3e50;">Congratulations ${
            user.fullName || "Broker"
          }!</h2>
          <p>Your application as an Introducing Broker has been <strong style="color:green;">approved</strong>.</p>
          
          <p><strong>Details:</strong></p>
          <ul>
            <li><strong>Email:</strong> ${user.email}</li>
            <li><strong>Referral Key:</strong> ${ib.referralCode}</li>
            <li><strong>Status:</strong> Approved</li>
            <li><strong>Date:</strong> ${new Date().toLocaleString()}</li>
          </ul>

          <p>You can now start referring clients using your referral key.</p>
          
          <p>If you have any questions, feel free to contact our support team.</p>
          <br/>
          <p>Best Regards,<br/>The Support Team</p>
        </div>
      `,
    });
    res.json({ message: "IB approved successfully", referralCode });
  } catch (err) {
    console.error("❌ Error approving IB:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * 📌 Reject IB Request (Admin Side)
 */
const rejectIBByEmail = async (req, res) => {
  try {
    const { email } = req.params;

    const ib = await IB.findOne({ email });
    if (!ib) return res.status(404).json({ message: "IB request not found" });

    ib.status = "rejected";
    await ib.save();
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });
    // 🔹 Send rejection email
    console.log(user.email);
    await sendEmail({
      to: user.email,
      subject: "Your Introducing Broker Application Rejected",
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
          <h2 style="color: #c0392b;">Application Update</h2>
          <p>Dear ${user.fullName || "Broker"},</p>
          <p>We regret to inform you that your application as an Introducing Broker has been <strong style="color:red;">rejected</strong> at this time.</p>
          
          <p><strong>Details:</strong></p>
          <ul>
            <li><strong>Email:</strong> ${user.email}</li>
            <li><strong>Status:</strong> Rejected</li>
            <li><strong>Date:</strong> ${new Date().toLocaleString()}</li>
          </ul>

          <p>If you believe this was a mistake or would like to reapply, please contact our support team for further guidance.</p>
          
          <br/>
          <p>Best Regards,<br/>The Support Team</p>
        </div>
      `,
    });
    res.json({ message: "IB rejected successfully" });
  } catch (err) {
    console.error("❌ Error rejecting IB:", err);
    res.status(500).json({ message: "Server error" });
  }
};

const referralCode = async (req, res) => {
  try {
    const { email } = req.params;

    // find user by email
    const ib = await IB.findOne({ email });

    if (!ib) {
      return res.status(404).json({ message: "IB not found" });
    }

    // assuming your schema has `referralCode` field
    return res.json({ referralCode: ib.referralCode });
  } catch (err) {
    console.error("❌ Error fetching referral code:", err);
    res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  registerIB,
  getAllIBRequests,
  approveIBByEmail,
  rejectIBByEmail,
  referralCode,
};
