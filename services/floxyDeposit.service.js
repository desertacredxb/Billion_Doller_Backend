// Floxy VND deposits via payment links.
//
// Flow: client enters VND -> rate locked (open.er-api.com) -> Order saved with
// the USD to credit -> Floxy payment link -> client pays on Floxy's page ->
// webhook (or admin reconciliation) -> Floxy confirms via authenticated GET ->
// MT5 credited once through the shared deposit-credit guard.
//
// The broker absorbs Floxy's fee: MT5 is credited the full VND amount at the
// rate locked when the link was created.
const axios = require("axios");
const { MIN_DEPOSIT_USD } = require("../config/depositLimits");

const PROVIDER = "FLOXY";
const CURRENCY = "VND";
// Floxy's minimum for VND bank QR (guide section 4).
const FLOXY_MIN_VND = 100000;
// Sanity bounds on VND per USD; a value outside this means the rate feed is
// broken, and we refuse rather than lock a wrong rate.
const VND_PER_USD_BOUNDS = [10000, 100000];
const RATE_URL = "https://open.er-api.com/v6/latest/USD";
// Unmatched webhooks re-check recent pending Floxy orders only.
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 50;
const CLOSED_LINK_STATUSES = ["failed", "expired", "disabled"];
const PAYMENT_EVENTS = ["payment.succeeded", "payment.failed", "payment.canceled"];

async function fetchVndPerUsd({ http = axios } = {}) {
  const { data } = await http.get(RATE_URL, { timeout: 10000 });
  const rate = Number(data?.rates?.VND);
  if (data?.result !== "success" || !Number.isFinite(rate) || rate < VND_PER_USD_BOUNDS[0] || rate > VND_PER_USD_BOUNDS[1]) {
    throw new Error("VND exchange rate unavailable");
  }
  return rate;
}

function minimumVnd(vndPerUsd) {
  return Math.max(FLOXY_MIN_VND, Math.ceil(MIN_DEPOSIT_USD * vndPerUsd));
}

function toUsd(vnd, vndPerUsd) {
  return Math.round((vnd / vndPerUsd) * 100) / 100;
}

function createFloxyDeposit({ client, orders, runDeposit, balanceWithClaim, fetchRate = fetchVndPerUsd, alert = async () => {}, notifyClient = async () => {}, logger = console, now = () => new Date() }) {
  // Candidate references to our order inside a Floxy payment object. The guide
  // documents metadata and merchant_order_id; the link-id field names are not
  // documented for link payments, so each plausible spelling is checked.
  function references(payment) {
    if (!payment || typeof payment !== "object") return { orderIds: [], linkIds: [] };
    const str = value => (typeof value === "string" && value ? [value] : []);
    return {
      orderIds: [...str(payment.metadata?.order_id), ...str(payment.merchant_order_id)],
      linkIds: [
        ...str(payment.payment_link), ...str(payment.payment_link_id), ...str(payment.link_id),
        ...str(payment.link?.id), ...str(payment.payment_link?.id),
      ].filter(id => id.startsWith("plink_")),
    };
  }

  async function findOrder(...payments) {
    for (const payment of payments) {
      const { orderIds, linkIds } = references(payment);
      if (orderIds.length) {
        const order = await orders.findOne({ provider: PROVIDER, orderid: { $in: orderIds } });
        if (order) return order;
      }
      if (linkIds.length) {
        const order = await orders.findOne({ provider: PROVIDER, "floxy.linkId": { $in: linkIds } });
        if (order) return order;
      }
    }
    return null;
  }

  // Must run inside runDeposit's claim for this order.
  async function settle(order, { payment, explicit = false } = {}) {
    if (order.status === "SUCCESS") return "already";
    const floxy = order.floxy || {};
    if (!floxy.linkId || !Number.isSafeInteger(floxy.localAmount) || !(order.amount > 0)) {
      throw new Error(`Floxy order ${order.orderid} is missing link or amount data`);
    }

    const link = await client.getPaymentLink(floxy.linkId);
    if (link?.id !== floxy.linkId) throw new Error(`Floxy returned a different link for ${order.orderid}`);
    const amountMatches = obj => obj?.amount === floxy.localAmount && obj?.currency === CURRENCY;

    const linkPaid = link.status === "completed";
    const paymentPaid = explicit && payment?.status === "succeeded";
    if ((linkPaid && !amountMatches(link)) || (paymentPaid && !amountMatches(payment))) {
      order.comment = "Floxy amount/currency differs from the order. Not credited; review in the Floxy panel.";
      await order.save();
      await alert(`Floxy amount mismatch - ${order.orderid}`, `Order ${order.orderid} (account ${order.accountNo}) expected VND ${floxy.localAmount}. Link ${floxy.linkId} reports ${link.amount} ${link.currency}; payment reports ${payment?.amount ?? "-"} ${payment?.currency ?? "-"}. Nothing was credited.`);
      return "mismatch";
    }

    if (linkPaid || paymentPaid) {
      const usd = Number(order.amount).toFixed(2);
      let mt5;
      try {
        mt5 = await balanceWithClaim({ login: order.accountNo, type: 2, balance: usd, comment: `DEP-${order.orderid}`.substring(0, 31) });
      } catch (error) {
        await alert(`Floxy deposit paid but MT5 credit FAILED - ${order.orderid}`, `Floxy confirmed payment for order ${order.orderid} (account ${order.accountNo}, VND ${floxy.localAmount} = $${usd}), but the MT5 credit failed or its result is unknown: ${error.message}. The order is locked for review: check MT5 deal history before doing anything.`);
        throw error;
      }
      order.status = "SUCCESS";
      order.floxy.linkStatus = link.status;
      if (payment?.id) order.floxy.paymentId = payment.id;
      order.floxy.paidAt = now();
      await order.save();
      logger.log(`Floxy deposit ${order.orderid} credited $${usd} to ${order.accountNo} (ticket ${mt5?.ticket || "n/a"})`);
      await notifyClient(order, { usd, vnd: floxy.localAmount, ticket: mt5?.ticket }).catch(() => {});
      return "credited";
    }

    if (CLOSED_LINK_STATUSES.includes(link.status)) {
      order.status = "FAILED";
      order.floxy.linkStatus = link.status;
      order.comment = `Floxy payment link ${link.status}.`;
      await order.save();
      return "failed";
    }

    if (order.floxy.linkStatus !== link.status) {
      order.floxy.linkStatus = link.status;
      await order.save();
    }
    return "pending";
  }

  async function settleOrder(orderid, options) {
    return runDeposit(orderid, order => settle(order, options), () => "already");
  }

  async function sweepRecent() {
    const since = new Date(now().getTime() - SWEEP_WINDOW_MS);
    const pending = await orders.find({ provider: PROVIDER, status: "PENDING", "floxy.linkId": { $exists: true }, createdAt: { $gte: since } })
      .sort({ createdAt: -1 }).limit(SWEEP_LIMIT);
    const results = [];
    for (const order of pending) {
      try { results.push(await settleOrder(order.orderid)); } catch (error) { logger.error(`Floxy sweep skipped ${order.orderid}: ${error.message}`); }
    }
    return results;
  }

  async function handleEvent(event) {
    if (!PAYMENT_EVENTS.includes(event?.type)) return { handled: false };
    const eventPayment = event?.data?.object;
    // Re-read the payment with our key: the event is only a trigger.
    const payment = await client.getPayment(eventPayment?.id);
    const order = await findOrder(payment, eventPayment);
    if (order) return { handled: true, result: await settleOrder(order.orderid, { payment, explicit: true }) };

    const results = await sweepRecent();
    if (payment?.status === "succeeded" && !results.includes("credited")) {
      await alert(`Unmatched Floxy payment - ${payment.id}`, `Floxy reported succeeded payment ${payment.id} (${payment.amount} ${payment.currency}), but no pending Floxy order could be matched or confirmed as paid. Check the Floxy panel and the deposits list.`);
    }
    return { handled: true, result: "swept" };
  }

  async function createDeposit({ account, vndAmount, makeOrderId }) {
    const vndPerUsd = await fetchRate();
    const minVnd = minimumVnd(vndPerUsd);
    if (vndAmount < minVnd) return { ok: false, status: 400, message: `The minimum deposit is VND ${minVnd.toLocaleString("en-US")}.`, minVnd };

    const usdAmount = toUsd(vndAmount, vndPerUsd);
    const orderid = makeOrderId();
    const order = await orders.create({
      orderid, account: account._id, accountNo: String(account.accountNo), amount: usdAmount, provider: PROVIDER, status: "PENDING",
      floxy: { currency: CURRENCY, localAmount: vndAmount, vndPerUsd, rateSource: "open.er-api.com" },
    });

    let link;
    try {
      link = await client.createPaymentLink({
        type: "fixed_amount", amount: vndAmount, currency: CURRENCY,
        description: `BillionDollarFX deposit ${orderid}`,
        metadata: { order_id: orderid, account_no: String(account.accountNo) },
      }, orderid);
    } catch (error) {
      order.status = "FAILED";
      order.comment = `Floxy link creation failed: ${error.code || error.status || "network"}`;
      await order.save();
      if (error.code === "amount_out_of_range") return { ok: false, status: 400, message: "This amount is outside Floxy's allowed range. Try a different amount." };
      logger.error(`Floxy link creation failed for ${orderid}: ${error.message}`);
      return { ok: false, status: 502, message: "Floxy is unavailable right now. Please try again shortly." };
    }

    const problems = [
      !(typeof link?.id === "string" && link.id.startsWith("plink_")) && "id",
      !(typeof link?.url === "string" && link.url.startsWith("https://")) && "url",
      link?.amount !== vndAmount && "amount",
      link?.currency !== CURRENCY && "currency",
    ].filter(Boolean);
    if (problems.length) {
      order.status = "FAILED";
      order.comment = `Floxy returned an unexpected payment link (${problems.join(", ")}).`;
      await order.save();
      // Field names and value types only: enough to diagnose, nothing sensitive.
      const shape = link && typeof link === "object"
        ? Object.entries(link).map(([key, value]) => `${key}:${Array.isArray(value) ? "array" : typeof value}`).join(",")
        : typeof link;
      logger.error(`Floxy returned an unexpected link for ${orderid}: failed [${problems.join(", ")}]; ` +
        `amount=${JSON.stringify(link?.amount)} currency=${JSON.stringify(link?.currency)}; response shape {${shape}}`);
      return { ok: false, status: 502, message: "Floxy is unavailable right now. Please try again shortly." };
    }

    order.providerOrderId = link.id;
    order.floxy.linkId = link.id;
    order.floxy.linkUrl = link.url;
    order.floxy.linkStatus = link.status;
    if (link.expires_at) order.floxy.expiresAt = new Date(link.expires_at);
    await order.save();

    return { ok: true, orderid, url: link.url, vndAmount, usdAmount, vndPerUsd, expiresAt: link.expires_at || null };
  }

  return { createDeposit, handleEvent, settle, settleOrder, sweepRecent, findOrder };
}

let defaultService;
function service() {
  if (!defaultService) {
    const { createClient } = require("../utils/floxyClient");
    const { runDeposit, balanceWithClaim } = require("./depositCredit.service");
    const sendEmail = require("../utils/sendEmail");
    const Account = require("../models/account.model");
    defaultService = createFloxyDeposit({
      client: createClient(),
      orders: require("../models/Order"),
      runDeposit, balanceWithClaim,
      alert: (subject, text) => sendEmail({ to: "support@billiondollarfx.com", subject: `⚠️ ${subject}`, html: `<p>${text}</p>` })
        .catch(error => console.error("Floxy alert email failed:", error.message)),
      notifyClient: async (order, { usd, vnd, ticket }) => {
        const account = await Account.findOne({ accountNo: order.accountNo }).populate("user");
        if (!account?.user?.email) return;
        await sendEmail({
          to: account.user.email,
          subject: "Deposit Successful - Balance Updated",
          html: `
            <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
              <h2 style="color: #2c3e50;">Deposit Confirmation</h2>
              <p>Dear ${account.user.fullName || "Customer"},</p>
              <p>Your deposit has been successfully processed and your trading balance has been updated.</p>
              <ul>
                <li><strong>Order ID:</strong> ${order.orderid}</li>
                <li><strong>Amount Deposited:</strong> VND ${vnd.toLocaleString("en-US")} (≈ $${usd})</li>
                <li><strong>Status:</strong> Successful</li>
                <li><strong>Ticket ID:</strong> ${ticket || "N/A"}</li>
                <li><strong>Date:</strong> ${new Date().toLocaleString()}</li>
              </ul>
              <p>The amount has been credited to your trading account <strong>${order.accountNo}</strong>.</p>
              <p>If you did not initiate this transaction, please contact our support team immediately.</p>
              <br/>
              <p>Best Regards,<br/>The Support Team</p>
            </div>`,
        });
      },
    });
  }
  return defaultService;
}

module.exports = { createFloxyDeposit, fetchVndPerUsd, minimumVnd, toUsd, service, PROVIDER, FLOXY_MIN_VND };
