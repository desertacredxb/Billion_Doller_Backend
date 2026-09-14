// Read-only endpoints over the local `Deal` collection, populated by MT5's
// IB commission webhook (see mt5WebhookController.js). Distinct from the
// live MT5_Controller "/deals" endpoints, which call the MT5 server
// directly on every request - these just query what's already stored.
const Deal = require("../models/Deal.model");
const { parseToUnixSeconds } = require("../utils/parseToUnixSeconds");

/**
 * List stored deals, optionally filtered by login and a [from, to] time
 * range, newest first, paginated. from/to accept any normal date/time
 * format (e.g. "2025-01-01", "2025-01-31T23:59:59Z") or a unix timestamp,
 * same as the live MT5 deal endpoints.
 */
exports.getDealsController = async (req, res) => {
  const { login, from, to, page, limit } = req.query;

  const pageNum = page !== undefined ? Number(page) : 1;
  const limitNum = limit !== undefined ? Number(limit) : 50;

  if (!Number.isInteger(pageNum) || pageNum < 1) {
    return res.status(400).json({ success: false, message: "page must be a positive integer." });
  }
  if (!Number.isInteger(limitNum) || limitNum < 1 || limitNum > 1000) {
    return res
      .status(400)
      .json({ success: false, message: "limit must be a positive integer up to 1000." });
  }

  const match = {};
  if (login) match.login = String(login);

  if (from !== undefined || to !== undefined) {
    try {
      const timeMatch = {};
      if (from !== undefined) timeMatch.$gte = parseToUnixSeconds(from, "from");
      if (to !== undefined) timeMatch.$lte = parseToUnixSeconds(to, "to");
      match.timeNum = timeMatch;
    } catch (parseError) {
      return res.status(400).json({ success: false, message: parseError.message });
    }
  }

  try {
    const pipeline = [
      { $addFields: { timeNum: { $convert: { input: "$time", to: "long", onError: null, onNull: null } } } },
      { $match: match },
      { $sort: { timeNum: -1, _id: -1 } },
      {
        $facet: {
          data: [{ $skip: (pageNum - 1) * limitNum }, { $limit: limitNum }],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    const [result] = await Deal.aggregate(pipeline);
    const data = result?.data || [];
    const total = result?.totalCount?.[0]?.count || 0;

    return res.status(200).json({
      success: true,
      data,
      pagination: { page: pageNum, limit: limitNum, total, pages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error("Error fetching stored deals:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};

/**
 * Get a single stored deal by its MT5 deal ticket (#DEAL_TICKET# / Order).
 */
exports.getDealByOrderController = async (req, res) => {
  const { order } = req.params;

  if (!order) {
    return res.status(400).json({ success: false, message: "order is required." });
  }

  try {
    const deal = await Deal.findOne({ order: String(order) });

    if (!deal) {
      return res.status(404).json({ success: false, message: "Deal not found." });
    }

    return res.status(200).json({ success: true, data: deal });
  } catch (error) {
    console.error("Error fetching stored deal:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
