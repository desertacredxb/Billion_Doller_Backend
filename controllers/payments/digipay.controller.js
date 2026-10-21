// DigiPay is closed by the owner's explicit instruction. Keep the existing
// route exports so old clients receive a clear refusal without loading provider
// credentials, creating an order, storing a callback or touching MT5.
function unavailable(_req, res) {
  return res.status(410).json({
    success: false,
    status: "UNAVAILABLE",
    message: "DigiPay is unavailable. Choose another supported payment method.",
  });
}
exports.handleDigipayDeposit = unavailable;
exports.handlePaymentCallback = unavailable;
