// Receives the trade webhook MT5 itself pushes (configured server-side in
// the MT5 Manager terminal's webhook screen, POSTing to
// /api/IbCommisionWebhook on every deal). Not called by our own app -
// this is an inbound endpoint MT5's server calls.
const Deal = require("../models/Deal.model");

exports.receiveIbCommissionWebhook = async (req, res) => {
  try {
    const body = req.body || {};
    const { Login, Order } = body;

    // Login + Order (the deal ticket) are the minimum needed to store and
    // later dedup a row - reject anything missing them rather than storing
    // a record we can't attribute or safely re-ingest.
    if (!Login || !Order) {
      console.error("MT5 webhook: missing Login or Order", body);
      return res.status(400).json({ success: false, message: "Login and Order are required" });
    }

    // Upsert keyed on the deal ticket (Order) - if MT5 retries the same
    // webhook delivery (timeout on their end, etc.), this overwrites the
    // same row instead of creating a duplicate.
    await Deal.findOneAndUpdate(
      { order: String(Order) },
      {
        login: String(Login),
        order: String(Order),
        action: body.Action !== undefined ? String(body.Action) : undefined,
        entry: body.Entry !== undefined ? String(body.Entry) : undefined,
        time: body.Time !== undefined ? String(body.Time) : undefined,
        expertPositionId:
          body.ExpertPositionID !== undefined ? String(body.ExpertPositionID) : undefined,
        symbol: body.Symbol !== undefined ? String(body.Symbol) : undefined,
        price: body.Price !== undefined ? String(body.Price) : undefined,
        volume: body.Volume !== undefined ? String(body.Volume) : undefined,
        profit: body.Profit !== undefined ? String(body.Profit) : undefined,
        pricePosition:
          body.PricePosition !== undefined ? String(body.PricePosition) : undefined,
        group: body.Group !== undefined ? String(body.Group) : undefined,
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
