// Only RameePay INR, RameePay Crypto and Cregis Crypto remain enabled.
function unavailable(_req, res) {
  return res.status(410).json({ success: false, status: "UNAVAILABLE", message: "TruePay9 is unavailable. Choose another supported payment method." });
}
exports.handleTruepay9Callback = unavailable;
