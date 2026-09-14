// Receives the trade webhook MT5 itself pushes (configured server-side in
// the MT5 Manager terminal's webhook screen, POSTing to
// /api/IbCommisionWebhook on every deal). Not called by our own app -
// this is an inbound endpoint MT5's server calls.
const Deal = require("../models/Deal.model");

const normalizePayloadKeys = (obj = {}) => {
  const normalized = {};
  for (const key of Object.keys(obj)) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      normalized[key.toLowerCase()] = obj[key];
    }
  }
  return normalized;
};

exports.receiveIbCommissionWebhook = async (req, res) => {
  try {
    const rawBody = req.body || {};
    // 1. Case normalization (handles Login, login, LOGIN, Order, order, etc.)
    const body = normalizePayloadKeys(rawBody);
    const { login, order } = body;

    // Login + Order (the deal ticket) are the minimum needed to store and
    // later dedup a row - reject anything missing them rather than storing
    // a record we can't attribute or safely re-ingest.
    if (!login || !order) {
      console.error("MT5 webhook: missing Login or Order", body);
      return res.status(400).json({ success: false, message: "Login and Order are required" });
    }

    // Upsert keyed on the deal ticket (Order) - if MT5 retries the same
    // webhook delivery (timeout on their end, etc.), this overwrites the
    // same row instead of creating a duplicate.
    await Deal.findOneAndUpdate(
      { order: String(order) },
      {
        login: String(loginogin),
        order: String(order),
        action: body.action !== undefined ? String(body.action) : undefined,
        entry: body.entry !== undefined ? String(body.entry) : undefined,
        time: body.time !== undefined ? String(body.time) : undefined,
        expertPositionId:
          body.expertpositionid !== undefined ? String(body.expertpositionid) : undefined,
        symbol: body.symbol !== undefined ? String(body.symbol) : undefined,
        price: body.price !== undefined ? String(body.price) : undefined,
        volume: body.volume !== undefined ? String(body.volume) : undefined,
        profit: body.profit !== undefined ? String(body.profit) : undefined,
        pricePosition:
          body.priceposition !== undefined ? String(body.priceposition) : undefined,
        group: body.group !== undefined ? String(body.group) : undefined,
        raw: body,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("Error saving MT5 webhook payload:", err);
    // Return a real error status (not a false 200) - if MT5's webhook
    // delivery retries on non-2xx responses, this is what gives a deal a
    // chance to be recorded on a later attempt instead of being silently
    // lost on a transient DB error.
    return res.status(500).json({ success: false, message: "Server error" });
  }
};
