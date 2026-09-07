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

async function checkCregisOrderStatus(cregisId) {
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

    if (data?.code === "00000" && data?.data) {
      return data.data.status; // "new", "paid", "expired", "paid_over", "paid_partial", "canceled"
    }
    return null;
  } catch (error) {
    console.error("Cregis status query error:", error.response?.data || error.message);
    return null;
  }
}

// =========================================================================
// HELPER: RAMEEPAY API CALL
// =========================================================================
async function checkRameeOrderStatus(orderid, provider) {
  try {
    const isCrypto = provider === "CRYPTO";
    const encryptedData = isCrypto
      ? encryptDataCrypto({ order_id: orderid })
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

    if (data?.status && data?.data) {
      const decrypted = isCrypto
        ? decryptDataCrypto(data.data)
        : decryptData(data.data);
      return decrypted.status; // "SUCCESS", "PENDING", "FAILED"
    }
    return null;
  } catch (error) {
    console.error("Ramee status query error:", error.message);
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

    const pendingOrderQuery = Order.find({ status: "PENDING" }).sort({ createdAt: 1 });
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

      let orderStatus = null;

      // -------------------------------------------------------------
      // QUERY PROVIDER API BASED ON PROVIDER TYPE
      // -------------------------------------------------------------
      if (provider === "RAMEE" || provider === "CRYPTO") {
        orderStatus = await checkRameeOrderStatus(order.orderid, provider);
      } else if (provider === "CREGIS") {
        const queryId = order.providerOrderId || order.orderid;
        orderStatus = await checkCregisOrderStatus(queryId);
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
        (provider === "CREGIS" && ["paid", "paid_over", "paid_partial"].includes(orderStatus)) ||
        (provider === "TRUSTPAY24" && orderStatus === "cleared");

      const isFailed =
        ((provider === "RAMEE" || provider === "CRYPTO") && orderStatus === "FAILED") ||
        (provider === "CREGIS" && ["expired", "canceled"].includes(orderStatus)) ||
        (provider === "TRUSTPAY24" && ["rejected", "refunded"].includes(orderStatus));

      if (isSuccess) {
        console.log(`✅ Order ${order.orderid} is confirmed PAID! Crediting MT5...`);

        const orderAmount = Number(order.amount);
        if (!Number.isFinite(orderAmount) || orderAmount <= 0) {
          console.error(`❌ Invalid order amount for ${order.orderid}:`, order.amount);
          continue;
        }
        const usdAmount = ["CREGIS", "CRYPTO"].includes(provider)
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