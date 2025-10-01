// controllers/ibController.js
const IB = require("../models/Broker.model");
const User = require("../models/User");
const sendEmail = require("../utils/sendEmail");
const { calculateClientCommission } = require("../utils/commissionService");

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

/**
 * Update IB commission for all their clients
 */
const updateIBCommission = async (req, res) => {
  const { email, sdate, edate } = req.body;

  if (!email || !sdate || !edate) {
    return res
      .status(400)
      .json({ success: false, message: "email, sdate, edate required" });
  }

  try {
    // 1️⃣ Find the IB record
    const ibRecord = await IB.findOne({ email });
    if (!ibRecord) {
      return res
        .status(404)
        .json({ success: false, message: "IB record not found" });
    }

    const referralCode = ibRecord.referralCode;
    if (!referralCode) {
      return res
        .status(400)
        .json({ success: false, message: "IB does not have a referral code" });
    }

    // 2️⃣ Find all users with the same referral code and populate accounts
    const clients = await User.find({ referralCode }).populate("accounts");
    console.log(`Found ${clients.length} clients for IB ${email}`);

    // 3️⃣ Calculate total commission
    let totalCommissionEarned = 0;

    for (const client of clients) {
      if (!client.accounts || client.accounts.length === 0) continue;

      for (const acc of client.accounts) {
        const clientCommission = await calculateClientCommission(
          acc.accountNo, // Use account number from populated Account
          sdate,
          edate
        );

        if (clientCommission > 0) {
          totalCommissionEarned += clientCommission;
        }
      }
    }

    // 4️⃣ Update IB's commission in User model
    const ibUser = await User.findOne({ email });
    if (!ibUser) {
      return res
        .status(404)
        .json({ success: false, message: "User record for IB not found" });
    }

    ibUser.commission = totalCommissionEarned;
    await ibUser.save();

    res.status(200).json({
      success: true,
      message: "IB commission updated successfully",
      totalCommission: ibUser.commission,
    });
  } catch (err) {
    console.error("Error updating IB commission:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

const withdrawCommission = async (req, res) => {
  try {
    const { email, accountno, amount } = req.body;

    if (!email || !accountno || !amount) {
      return res.status(400).json({
        success: false,
        message: "email, accountno, amount, and orderid are required",
      });
    }

    orderid = "ORD" + Date.now();

    // 🔹 Get the user
    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
    }

    // 🔹 Check commission balance
    if (user.commission < 75) {
      return res.status(400).json({
        success: false,
        message: "Minimum $75 commission required to withdraw",
      });
    }

    if (amount > user.commission) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal amount exceeds available commission",
      });
    }

    // 🔹 Call MoneyPlant FX API to add balance
    const response = await axios.post(
      "https://api.moneyplantfx.com/WSMoneyplant.aspx?type=SNDPAddBalance",
      { accountno, amount, orderid },
      { headers: { "Content-Type": "application/json" } }
    );

    const { response: status, message } = response.data;

    if (status === "success") {
      // 🔹 Deduct commission and save withdrawal date
      user.commission -= amount;
      user.lastWithdrawalDate = new Date();
      await user.save();

      return res.status(200).json({
        success: true,
        message: "Withdrawal successful",
        newCommission: user.commission,
        lastWithdrawalDate: user.lastWithdrawalDate,
      });
    } else {
      return res.status(400).json({ success: false, message });
    }
  } catch (error) {
    console.error("Commission withdrawal error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again later.",
    });
  }
};

module.exports = {
  registerIB,
  getAllIBRequests,
  approveIBByEmail,
  rejectIBByEmail,
  referralCode,
  updateIBCommission,
  withdrawCommission,
};
