// controllers/paymentAdmin.controller.js
// Admin/listing endpoints for deposits and withdrawals (not tied to a single payment provider).
const Order = require("../models/Order");
const Withdrawal = require("../models/withdrawal");
const reconcilePendingOrders = require("../utils/syncPendingOrders");

exports.reconcileOrders = async (req, res) => {
  // Add admin authentication check here
  try {
    const requestedCount = req.body?.count ?? req.body?.orderCount ?? req.body?.limit;
    const orderCount = requestedCount === undefined ? null : Number(requestedCount);

    if (orderCount !== null && (!Number.isInteger(orderCount) || orderCount <= 0)) {
      return res.status(400).json({
        success: false,
        message: "count must be a positive integer",
      });
    }

    await reconcilePendingOrders(orderCount);
    return res.json({
      success: true,
      message: orderCount === null
        ? "All pending orders reconciliation completed."
        : `Reconciliation completed for up to ${orderCount} pending orders.`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

// Shared page/limit parsing for the admin list* endpoints below - clamps to
// sane bounds so a bad/huge ?limit= can't force one query to pull the whole
// collection.
function parsePagination(req, defaultLimit) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || defaultLimit));
  return { page, limit, skip: (page - 1) * limit };
}

exports.listWithdrawals = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req, 15);

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      Withdrawal.countDocuments(),
    ]);

    res.json({ success: true, data: withdrawals, total, page, limit });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getDepositsByAccount = async (req, res) => {
  try {
    const { accountNo } = req.params;

    // Find all deposits for this account, sorted by latest first
    const deposits = await Order.find({ accountNo }).sort({ createdAt: -1 });

    // Return success with empty array if no deposits
    if (!deposits || deposits.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        deposits: [],
        message: "No deposits found for this account",
      });
    }

    res.status(200).json({
      success: true,
      count: deposits.length,
      deposits,
    });
  } catch (err) {
    console.error("❌ Error fetching deposits:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getWithdrawalsByAccount = async (req, res) => {
  try {
    const { accountNo } = req.params;

    // Find all withdrawals for this account, latest first
    const withdrawals = await Withdrawal.find({ accountNo }).sort({
      createdAt: -1,
    });

    if (!withdrawals || withdrawals.length === 0) {
      return res.status(200).json({
        success: true,
        count: 0,
        withdrawals: [],
        message: "No withdrawals found for this account",
      });
    }

    res.status(200).json({
      success: true,
      count: withdrawals.length,
      withdrawals,
    });
  } catch (err) {
    console.error("❌ Error fetching withdrawals:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.listAllDeposits = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req, 10);

    const [deposits, total] = await Promise.all([
      Order.find()
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate({
          path: "account",
          select: "accountNo balance user", // pick only what you need
          populate: {
            path: "user",
            select: "fullName email", // adjust based on your User schema
          },
        }),
      Order.countDocuments(),
    ]);

    // 404 only when the collection itself is empty - a page past the end of
    // an otherwise non-empty result set is a normal empty page, not an error.
    if (total === 0) {
      return res.status(404).json({
        success: false,
        message: "No deposits found",
      });
    }

    const formatted = deposits.map((d) => ({
      orderid: d.orderid,
      amount: d.amount,
      status: d.status,
      // How much of `amount` has actually been credited to MT5 so far - relevant
      // when status is PARTIALLY_PAID (a Cregis order still owed a top-up).
      creditedAmount: d.creditedAmount || 0,
      remainingAmount: Math.max(0, Number((d.amount - (d.creditedAmount || 0)).toFixed(2))),
      createdAt: d.createdAt,
      accountNo: d.account?.accountNo || d.accountNo, // fallback
      balance: d.account?.balance || 0,
      userName: d.account?.user?.fullName || "Unknown",
    }));

    res.status(200).json({
      success: true,
      count: formatted.length,
      total,
      page,
      limit,
      deposits: formatted,
    });
  } catch (err) {
    console.error("❌ Error fetching deposits:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.listAllWithdrawals = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req, 10);

    const [withdrawals, total] = await Promise.all([
      Withdrawal.find().sort({ createdAt: -1 }).skip(skip).limit(limit),
      Withdrawal.countDocuments(),
    ]);

    // 404 only when the collection itself is empty - a page past the end of
    // an otherwise non-empty result set is a normal empty page, not an error.
    if (total === 0) {
      return res.status(404).json({
        success: false,
        message: "No withdrawals found ",
      });
    }

    res.status(200).json({
      success: true,
      count: withdrawals.length,
      total,
      page,
      limit,
      withdrawals,
    });
  } catch (err) {
    console.error("❌ Error fetching withdrawals:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
