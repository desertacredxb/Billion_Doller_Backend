const axios = require("axios");
const crypto = require("crypto");
const Order = require("../models/Order");
const { updateMT5Balance } = require("./MT5/mt5Balance");
const {
  encryptData,
  decryptData,
  decryptDataCrypto,
  encryptDataCrypto,
} = require("../utils/rameeCrypto");

async function fetchRate() {
  try {
    const { data } = await axios.get(
      "https://api.frankfurter.app/latest?amount=1&from=INR&to=USD",
      { timeout: 10000 }
    );
    return data.rates.USD;
  } catch (error) {
    console.error("INR to USD rate error:", error.message);
    return 0.012;
  }
}
// =========================================================================
// HELPER: CREGIS SIGNATURE & API CALL
// =========================================================================
function generateCregisSignature(params) {
  const apiKey = process.env.CREGIS_DEPOSIT_API_KEY;
  const sortedKeys = Object.keys(params)
    .filter((k) => k !== "sign" && params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort();

  let stringToSign = "";
  for (const key of sortedKeys) {
    stringToSign += `${key}${params[key]}`;
  }
  stringToSign = apiKey + stringToSign;

  return crypto.createHash("md5").update(stringToSign).digest("hex").toLowerCase();
}

// Returns the full order-info object (status + settlement amounts), not just the
// status string, so the caller can credit the actual settled amount for
// paid_partial/paid_over orders instead of assuming the full order.amount arrived.
async function checkCregisOrderInfo(cregisId) {
  try {
    const nonce = crypto.randomBytes(3).toString("hex");
    const timestamp = Date.now();
    const pid = Number(process.env.CREGIS_DEPOSIT_PID);

    const payload = {
      nonce,
      pid,
      timestamp,
      cregis_id: cregisId,
    };

    payload.sign = generateCregisSignature(payload);

    const { data } = await axios.post("https://t-jcgfykxv.cregis.io/api/v2/order/info", payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    console.log(data)

    if (data?.code === "00000" && data?.data) {
      // status: "new", "paid", "expired", "paid_over", "paid_partial", "canceled"
      // also carries order_amount, receive_amount, receive_currency, pay_amount, pay_currency
      return data.data;
    }
    return null;
  } catch (error) {
    console.error("Cregis status query error:", error.response?.data || error.message);
    return null;
  }
}

// Mirrors the delta-crediting logic in controllers/payments/cregis.controller.js:
// credit only the difference between what Cregis reports as settled and what
// we've already put into MT5 for this order (order.creditedAmount), so a
// paid_partial order picked up here behaves the same whether it's finalized by
// a webhook or by this reconciliation job.
async function reconcileCregisOrder(order, cregisInfo) {
  if (!cregisInfo) {
    console.log(`⏳ Order ${order.orderid} - no response from Cregis order-info API.`);
    return;
  }

  const status = cregisInfo.status;
  console.log(`Cregis order-info status for ${order.orderid}:`, status);

  if (status === "expired" || status === "canceled") {
    order.status = "FAILED";
    order.comment = `Marked FAILED during reconciliation (Cregis status: ${status}).`;
    await order.save();
    console.log(`❌ Order ${order.orderid} marked FAILED in DB.`);
    return;
  }

  if (!["paid", "paid_over", "paid_partial"].includes(status)) {
    console.log(`⏳ Order ${order.orderid} still pending on Cregis side (status: ${status || "unknown"}).`);
    return;
  }

  const accountno = order.accountNo;
  const settlementCurrency = String(cregisInfo.receive_currency || "").toUpperCase();
  const isUsdEquivalent = !settlementCurrency || ["USD", "USDT", "USDC"].includes(settlementCurrency);

  const reportedTotal =
    isUsdEquivalent && cregisInfo.receive_amount
      ? Number(cregisInfo.receive_amount)
      : Number(order.amount || cregisInfo.order_amount);

  if (!Number.isFinite(reportedTotal) || reportedTotal <= 0) {
    console.error(`❌ Invalid settlement amount from Cregis for ${order.orderid}:`, cregisInfo.receive_amount);
    return;
  }

  const alreadyCredited = Number(order.creditedAmount || 0);
  const creditDelta = Number((reportedTotal - alreadyCredited).toFixed(2));

  if (creditDelta <= 0) {
    // Nothing new to credit, but finalize the status if Cregis now shows it fully paid.
    if (status !== "paid_partial" && order.status !== "SUCCESS") {
      order.status = "SUCCESS";
      order.comment = `Reconciled manually on ${new Date().toISOString()}`;
      await order.save();
      console.log(`🎉 Order ${order.orderid} finalized as SUCCESS during reconciliation (already fully credited).`);
    }
    return;
  }

  try {
    const mt5Response = await updateMT5Balance({
      login: accountno,
      type: 2,
      balance: creditDelta.toFixed(2),
      comment: `RECON-${order.orderid}`.substring(0, 32),
    });

    const retcode = String(mt5Response?.retcode ?? mt5Response?.data?.retcode ?? "");

    if (retcode === "0 Done" || retcode === "0" || retcode.startsWith("0 ")) {
      order.creditedAmount = Number((alreadyCredited + creditDelta).toFixed(2));
      order.status = status === "paid_partial" ? "PARTIALLY_PAID" : "SUCCESS";
      order.comment = `Reconciled manually on ${new Date().toISOString()}`;
      await order.save();
      console.log(
        `🎉 Account ${accountno} credited with $${creditDelta.toFixed(2)} USD (order ${order.orderid}, status: ${order.status}).`
      );
    } else {
      console.error(`❌ MT5 deposit error: ${retcode || "missing retcode"}`);
    }
  } catch (mt5Err) {
    console.error(`❌ MT5 API Exception for ${order.orderid}:`, mt5Err.message);
  }
}

// =========================================================================
// HELPER: RAMEEPAY API CALL
// =========================================================================
async function checkRameeOrderStatus(orderid, provider) {
  try {
    // Standardize provider check (case-insensitive)
    const isCrypto = String(provider).toUpperCase() === "CRYPTO";

    const encryptedData = isCrypto
      ? encryptDataCrypto({ orderid: orderid })
      : encryptData({ order_id: orderid });

    const payload = isCrypto
      ? { data: encryptedData, agentCode: process.env.CRYPTO_AGENT_CODE }
      : { reqData: encryptedData, agentCode: process.env.RAMEE_AGENT_CODE };

    const statusUrl = isCrypto
      ? "https://crypto-apis.rameepay.io/v1/order/status"
      : "https://apis.rameepay.io/order/status";

    const { data } = await axios.post(statusUrl, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: 10000,
    });

    console.log("API Raw Response:", data);

    // FIXED: Check data.success instead of data.status
    if (data?.success && data?.data) {
      const decrypted = isCrypto
        ? decryptDataCrypto(data.data)
        : decryptData(data.data);

      console.log("Decrypted Payload:", decrypted);

      // Return status if object, or return raw payload if string/other
      return typeof decrypted === "object" ? decrypted?.status : decrypted;
    }

    return null;
  } catch (error) {
    console.error("Ramee status query error:", error.response?.data || error.message);
    return null;
  }
}

// =========================================================================
// HELPER: TRUSTPAY API CALL
// =========================================================================
async function checkTrustPayOrderStatus(transactionId) {
  try {
    const { data } = await axios.get(
      `https://trustpay-api.com/api/withdrawal/transactions/status?transactionId=${transactionId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.TRUSTPAY_API_KEY}`,
        },
        timeout: 10000,
      }
    );

    if (data?.code === 200 && data?.data) {
      return data.data.status; // "pending", "picked", "utr_submitted", "cleared", "rejected", "refunded"
    }
    return null;
  } catch (error) {
    console.error("TrustPay status query error:", error.response?.data || error.message);
    return null;
  }
}

// =========================================================================
// MAIN RECONCILIATION FUNCTION
// =========================================================================
async function reconcilePendingOrders(orderCount = null) {
  try {
    console.log(
      orderCount !== null
        ? `🔍 Starting reconciliation for ${orderCount} pending orders...`
        : "🔍 Starting pending orders reconciliation job..."
    );

    // PARTIALLY_PAID is included so a Cregis order still owed a top-up gets
    // re-checked here too, in case its "paid_remain" webhook never arrived.
    const pendingOrderQuery = Order.find({ status: { $in: ["PENDING", "PARTIALLY_PAID"] } }).sort({ createdAt: -1 });
    if (orderCount !== null) pendingOrderQuery.limit(orderCount);
    const pendingOrders = await pendingOrderQuery;

    console.log(`📋 Found ${pendingOrders.length} pending orders to reconcile.`);

    for (const order of pendingOrders) {
      console.log(`\n----------------------------------------`);
      console.log(`Processing Order: ${order.orderid}`);

      let provider = order.provider ? order.provider.toUpperCase() : "";

      // -------------------------------------------------------------
      // FALLBACK DETECTOR: IF PROVIDER IS NOT SPECIFIED IN DATABASE
      // -------------------------------------------------------------
      if (!provider) {
        if (order.orderid.startsWith("RAMEE") || order.orderid.startsWith("ORP")) {
          provider = "RAMEE";
        } else if (order.orderid.startsWith("OCP")) {
          provider = "CRYPTO";
        } else if (order.orderid.startsWith("ORD") || order.providerOrderId?.startsWith("po")) {
          provider = "CREGIS";
        } else if (order.providerOrderId) {
          provider = "TRUSTPAY24";
        } else {
          console.warn(`⚠️ Cannot infer provider for Order ID: ${order.orderid}. Skipping.`);
          continue;
        }

        // Save inferred provider back to order
        order.provider = provider;
        await order.save();
        console.log(`⚙️ Inferred provider as: ${provider}`);
      }

      // CREGIS needs the full settlement breakdown (not just a status string) to
      // credit only what's actually been paid, so it gets its own dedicated path.
      if (provider === "CREGIS") {
        const queryId = order.providerOrderId || order.orderid;
        const cregisInfo = await checkCregisOrderInfo(queryId);
        await reconcileCregisOrder(order, cregisInfo);
        continue;
      }

      let orderStatus = null;

      // -------------------------------------------------------------
      // QUERY PROVIDER API BASED ON PROVIDER TYPE
      // -------------------------------------------------------------
      if (provider === "RAMEE" || provider === "CRYPTO") {
        orderStatus = await checkRameeOrderStatus(order.orderid, provider);
      } else if (provider === "TRUSTPAY24") {
        const queryId = order.providerOrderId || order.orderid;
        orderStatus = await checkTrustPayOrderStatus(queryId);
      }

      console.log(`Gateway Response Status for ${order.orderid}:`, orderStatus);

      // -------------------------------------------------------------
      // MAP GATEWAY STATUS & EXECUTE BALANCE UPDATES
      // -------------------------------------------------------------
      const isSuccess =
        ((provider === "RAMEE" || provider === "CRYPTO") && orderStatus === "SUCCESS") ||
        (provider === "TRUSTPAY24" && orderStatus === "cleared");

      const isFailed =
        ((provider === "RAMEE" || provider === "CRYPTO") && orderStatus === "FAILED") ||
        (provider === "TRUSTPAY24" && ["rejected", "refunded"].includes(orderStatus));

      if (isSuccess) {
        console.log(`✅ Order ${order.orderid} is confirmed PAID! Crediting MT5...`);

        const orderAmount = Number(order.amount);
        if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
          console.error(`❌ Invalid order amount for ${order.orderid}:`, order.amount);
          continue;
        }
        // CREGIS is handled separately above (reconcileCregisOrder), so only
        // CRYPTO reaches here needing a 1:1 USD amount; RAMEE/TRUSTPAY24 need INR->USD.
        const usdAmount = provider === "CRYPTO"
          ? orderAmount.toFixed(2)
          : (orderAmount * await fetchRate()).toFixed(2);
        const accountno = order.accountNo;

        try {
          const mt5Response = await updateMT5Balance({
            login: accountno,
            type: 2,
            balance: usdAmount,
            comment: `RECON-${order.orderid}`.substring(0, 32),
          });

          const retcode = String(mt5Response?.retcode ?? mt5Response?.data?.retcode ?? "");

          if (retcode === "0 Done" || retcode === "0" || retcode.startsWith("0 ")) {
            order.status = "SUCCESS";
            order.comment = `Reconciled manually on ${new Date().toISOString()}`;
            await order.save();
            console.log(`🎉 Account ${accountno} credited with $${usdAmount} USD.`);
          } else {
            console.error(`❌ MT5 deposit error: ${retcode || "missing retcode"}`);
          }
        } catch (mt5Err) {
          console.error(`❌ MT5 API Exception for ${order.orderid}:`, mt5Err.message);
        }
      } else if (isFailed) {
        order.status = "FAILED";
        order.comment = `Marked FAILED during reconciliation.`;
        await order.save();
        console.log(`❌ Order ${order.orderid} marked FAILED in DB.`);
      } else {
        console.log(`⏳ Order ${order.orderid} is still pending on provider side (${orderStatus || "No status"}).`);
      }
    }

    console.log("\n✅ Reconciliation finished successfully.");
  } catch (error) {
    console.error("Critical Reconciliation Error:", error);
  }
}

module.exports = reconcilePendingOrders;