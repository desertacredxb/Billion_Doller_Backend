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
      receive_amount,
      receive_currency,
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
      // "paid" = fully paid in one shot.
      // "paid_partial" = payment received but less than the order amount - credit what
      // actually came in now, and leave the order open for the remainder.
      // "paid_remain" = the top-up that completes an order previously left "paid_partial".
      // "paid_over" = order paid in full (and then some) in one shot - already fully covered,
      // no further webhook will follow, so it must be credited now rather than left PENDING.
      case "paid":
      case "paid_partial":
      case "paid_remain":
      case "paid_over": {
        console.log(`Cregis payment update (${event_type}):`, targetOrderId);

        const accountno = order.accountNo;
        if (!accountno) {
          console.error("Account number missing for order:", targetOrderId);
          return res.status(200).send("success");
        }

        // Cregis reports the order's cumulative settled total on every callback
        // (receive_amount), not a per-transaction delta - so we credit only the
        // difference vs what we've already put into MT5 for this order
        // (order.creditedAmount), which makes paid_partial -> paid_remain safe to
        // credit twice without double-paying the customer. receive_currency should
        // be a USD-equivalent since orders are created with order_currency "USD"
        // and stablecoin_realtime_rate locked to 1:1; if it's anything else (or
        // missing), fall back to the fixed order amount rather than crediting a
        // number denominated in the wrong currency.
        const settlementCurrency = String(receive_currency || "").toUpperCase();
        const isUsdEquivalent =
          !settlementCurrency || ["USD", "USDT", "USDC"].includes(settlementCurrency);

        const reportedTotal =
          isUsdEquivalent && receive_amount
            ? Number(receive_amount)
            : Number(order.amount || order_amount);

        if (!Number.isFinite(reportedTotal) || reportedTotal <= 0) {
          console.error("Invalid settlement amount reported by Cregis:", receive_amount, order_amount);
          return res.status(200).send("success");
        }

        const alreadyCredited = Number(order.creditedAmount || 0);
        const creditDelta = Number((reportedTotal - alreadyCredited).toFixed(2));

        if (creditDelta <= 0) {
          // Nothing new to credit - duplicate/replayed webhook, or already settled.
          console.log(
            `No new amount to credit for ${targetOrderId} (event ${event_type}); already credited $${alreadyCredited}.`
          );
          if (event_type !== "paid_partial" && order.status !== "SUCCESS") {
            order.status = "SUCCESS";
            await order.save();
          }
          return res.status(200).send("success");
        }

        // Update MT5 Trading Account Balance in USD with just the new amount
        try {
          console.log(`Crediting $${creditDelta.toFixed(2)} USD to MT5 account ${accountno}...`);

          const mt5Response = await updateMT5Balance({
            login: accountno,
            type: 2, // Deposit type
            balance: creditDelta.toFixed(2),
            comment: `${alreadyCredited > 0 ? "TOP" : "DEP"}-${targetOrderId}`.substring(0, 31),
          });

          console.log("💰 MT5 Response:", mt5Response);

          const retCode = String(mt5Response.retcode || "");

          if (!retCode.startsWith("0") && retCode !== "0 Done") {
            throw new Error(`MT5 Deposit Failed: ${mt5Response.retcode}`);
          }

          order.creditedAmount = Number((alreadyCredited + creditDelta).toFixed(2));
          order.status = event_type === "paid_partial" ? "PARTIALLY_PAID" : "SUCCESS";
          await order.save();
          console.log(`Order ${targetOrderId} now: status=${order.status}, creditedAmount=$${order.creditedAmount}`);

          // Email Notification
          try {
            const account = await Account.findOne({ accountNo: accountno }).populate("user");
            const isFinal = order.status === "SUCCESS";
            const remaining = Number((Number(order.amount) - order.creditedAmount).toFixed(2));

            if (account?.user?.email) {
              await sendEmail({
                to: account.user.email,
                subject: isFinal
                  ? "Deposit Successful - Balance Updated"
                  : "Partial Deposit Received - Balance Updated",
                html: `
                  <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    <h2 style="color: #2c3e50;">${isFinal ? "Deposit Confirmation" : "Partial Deposit Received"}</h2>
                    <p>Dear ${account.user.fullName || "Customer"},</p>
                    <p>${isFinal
                      ? `Your deposit of <strong>$${creditDelta.toFixed(2)} USD</strong> has been credited to your MT5 trading account.`
                      : `We've received a partial payment of <strong>$${creditDelta.toFixed(2)} USD</strong> towards your deposit and credited it to your MT5 trading account. Please send the remaining <strong>$${remaining > 0 ? remaining.toFixed(2) : "0.00"} USD</strong> to complete this order.`
                    }</p>
                    <p><strong>Transaction Details:</strong></p>
                    <ul>
                      <li><strong>Order ID:</strong> ${targetOrderId}</li>
                      <li><strong>Cregis ID:</strong> ${cregis_id || "N/A"}</li>
                      <li><strong>Transaction ID:</strong> ${tx_id || "N/A"}</li>
                      <li><strong>Ticket ID:</strong> ${mt5Response.ticket || "N/A"}</li>
                      <li><strong>Paid In Crypto:</strong> ${pay_amount || "N/A"} ${pay_currency || ""}</li>
                      <li><strong>Amount Credited This Update:</strong> $${creditDelta.toFixed(2)} USD</li>
                      <li><strong>Total Credited So Far:</strong> $${order.creditedAmount} USD</li>
                      <li><strong>Trading Account:</strong> ${accountno}</li>
                      <li><strong>Status:</strong> ${isFinal ? "Successful" : "Partially Paid"}</li>
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
          // Don't lose track of a prior successful partial credit if this top-up attempt fails.
          order.status = alreadyCredited > 0 ? "PARTIALLY_PAID" : "PENDING";
          await order.save();
        }
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
