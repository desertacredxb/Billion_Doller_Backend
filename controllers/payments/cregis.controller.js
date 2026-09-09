const Order = require("../../models/Order");
const Withdrawal = require("../../models/withdrawal");
const Account = require("../../models/account.model");
const sendEmail = require("../../utils/sendEmail");
const { updateMT5Balance } = require("../../utils/MT5/mt5Balance");
const { sendSuccessEmail, refundToMT5 } = require("../payout.controller");

exports.handleCregisCallback = async (req, res) => {
  try {
    console.log("========== CREGIS CALLBACK ==========");
    console.log(JSON.stringify(req.body, null, 2));

    const { event_type, data } = req.body;

    if (!event_type || !data) {
      console.error("Invalid Cregis callback payload format");
      return res.status(200).send("success"); // Always return 200 to acknowledge webhook
    }

    const {
      order_id,
      cregis_id,
      order_amount,
      pay_amount,
      pay_currency,
      tx_id,
    } = data;

    if (!order_id) {
      console.error("Missing order_id in Cregis callback");
      return res.status(200).send("success");
    }

    const targetOrderId = String(order_id);

    // =========================================================================
    // CHECK 1: WITHDRAWALS / PAYOUTS
    // =========================================================================
    const withdrawal = await Withdrawal.findOne({ orderid: targetOrderId });

    if (withdrawal) {
      console.log("📌 Cregis Withdrawal Matched:", targetOrderId);

      if (["Completed", "Failed"].includes(withdrawal.status)) {
        console.log("Withdrawal already processed:", targetOrderId);
        return res.status(200).send("success");
      }

      if (event_type === "paid" || event_type === "success") {
        withdrawal.status = "Completed";
        withdrawal.transactionReference = tx_id || withdrawal.transactionReference;
        withdrawal.response = { ...withdrawal.response, callbackData: data, event_type };
        await withdrawal.save();

        await sendSuccessEmail(withdrawal);
        console.log(`✅ Cregis Withdrawal Completed: ${targetOrderId}`);
      } else if (["failed", "expired", "refunded", "cancelled"].includes(event_type)) {
        withdrawal.status = "Failed";
        withdrawal.response = { ...withdrawal.response, callbackData: data, event_type };
        await withdrawal.save();

        await refundToMT5(
          withdrawal.accountNo,
          withdrawal.amount,
          withdrawal.currency
        );
        console.log(`❌ Cregis Withdrawal Failed & Refunded: ${targetOrderId}`);
      }

      return res.status(200).send("success");
    }

    // =========================================================================
    // CHECK 2: DEPOSITS / PAYINS
    // =========================================================================
    const order = await Order.findOne({ orderid: targetOrderId });

    if (!order) {
      console.error("Neither Order nor Withdrawal found for ID:", targetOrderId);
      return res.status(200).send("success");
    }

    if (!order.provider) order.provider = "CREGIS";
    if (!order.providerOrderId && cregis_id) order.providerOrderId = String(cregis_id);

    if (order.status === "SUCCESS") {
      console.log("Order already processed:", targetOrderId);
      return res.status(200).send("success");
    }

    switch (event_type) {
      case "paid": {
        console.log("Cregis payment successful:", targetOrderId);

        const accountno = order.accountNo;
        if (!accountno) {
          console.error("Account number missing for order:", targetOrderId);
          return res.status(200).send("success");
        }

        // Direct 1:1 USD settlement. Use original order amount in USD.
        const usdAmountToCredit = Number(order.amount || order_amount).toFixed(2);

        if (!usdAmountToCredit || Number(usdAmountToCredit) <= 0) {
          console.error("Invalid USD amount to credit:", usdAmountToCredit);
          return res.status(200).send("success");
        }

        // Update MT5 Trading Account Balance in USD
        try {
          console.log(`Crediting $${usdAmountToCredit} USD to MT5 account ${accountno}...`);

          const mt5Response = await updateMT5Balance({
            login: accountno,
            type: 2, // Deposit type
            balance: usdAmountToCredit,
            comment: `DEP-${targetOrderId}`.substring(0, 31),
          });

          console.log("💰 MT5 Response:", mt5Response);

          const retCode = String(mt5Response.retcode || "");

          if (!retCode.startsWith("0") && retCode !== "0 Done") {
            throw new Error(`MT5 Deposit Failed: ${mt5Response.retcode}`);
          }

          order.status = "SUCCESS";
          await order.save();
          console.log("Order marked SUCCESS:", targetOrderId);

          // Email Notification
          try {
            const account = await Account.findOne({ accountNo: accountno }).populate("user");
            if (account?.user?.email) {
              await sendEmail({
                to: account.user.email,
                subject: "Deposit Successful - Balance Updated",
                html: `
                  <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2 style="color: #2c3e50;">Deposit Confirmation</h2>
                    <p>Dear ${account.user.fullName || "Customer"},</p>
                    <p>Your deposit of <strong>$${usdAmountToCredit} USD</strong> has been credited to your MT5 trading account.</p>
                    <p><strong>Transaction Details:</strong></p>
                    <ul>
                      <li><strong>Order ID:</strong> ${targetOrderId}</li>
                      <li><strong>Cregis ID:</strong> ${cregis_id || "N/A"}</li>
                      <li><strong>Transaction ID:</strong> ${tx_id || "N/A"}</li>
                      <li><strong>Ticket ID:</strong> ${mt5Response.ticket || "N/A"}</li>
                      <li><strong>Paid In Crypto:</strong> ${pay_amount || "N/A"} ${pay_currency || ""}</li>
                      <li><strong>Amount Credited:</strong> $${usdAmountToCredit} USD</li>
                      <li><strong>Trading Account:</strong> ${accountno}</li>
                      <li><strong>Status:</strong> Successful</li>
                    </ul>
                  </div>
                `,
              });
            }
          } catch (emailError) {
            console.error("Confirmation email failed:", emailError.message);
          }
        } catch (mt5Error) {
          console.error("MT5 Deposit Error:", mt5Error.message);
          order.status = "PENDING";
          await order.save();
        }
        break;
      }

      case "paid_partial":
      case "paid_over": {
        console.warn(`Cregis ${event_type}:`, targetOrderId, pay_amount);
        order.status = "PENDING";
        await order.save();
        break;
      }

      case "expired":
      case "refunded":
      case "canceled": {
        console.log(`Cregis order ${event_type}:`, targetOrderId);
        order.status = "FAILED";
        await order.save();
        break;
      }

      default: {
        console.warn("Unhandled Cregis event:", event_type);
        await order.save();
      }
    }

    return res.status(200).send("success");
  } catch (error) {
    console.error("Cregis callback error:", error.message);
    return res.status(200).send("success");
  }
};
