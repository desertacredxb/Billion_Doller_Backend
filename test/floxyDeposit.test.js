const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createGuard, balanceWithClaim } = require("../services/depositCredit.service");
const { createFloxyDeposit, fetchVndPerUsd, minimumVnd, toUsd } = require("../services/floxyDeposit.service");
const { verifySignature } = require("../utils/floxyClient");

const SECRET = "whsec_test";
const sign = (body, t, secret = SECRET) => `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

function store(patch = {}) {
  const record = {
    _id: "db1", orderid: "FLX1", accountNo: "1001", provider: "FLOXY", amount: 10, creditedAmount: 0, status: "PENDING", comment: "",
    createdAt: new Date(), floxy: { currency: "VND", localAmount: 260000, vndPerUsd: 26000, linkId: "plink_1", linkStatus: "active" }, ...patch,
  };
  const get = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
  const matches = filter => Object.entries(filter).every(([key, expected]) => {
    const actual = get(record, key);
    if (expected?.$ne !== undefined) return actual !== expected.$ne;
    if (expected?.$nin) return !expected.$nin.includes(actual);
    if (expected?.$in) return expected.$in.includes(actual);
    if (expected?.$exists !== undefined) return (actual !== undefined) === expected.$exists;
    if (expected?.$gte) return actual >= expected.$gte;
    return actual === expected;
  });
  const doc = () => ({ ...structuredClone(record), async save() {
    Object.assign(record, { status: this.status, comment: this.comment, creditedAmount: this.creditedAmount, floxy: structuredClone(this.floxy) });
  } });
  const apply = update => {
    for (const [key, value] of Object.entries(update.$set || {})) {
      const path = key.split("."); let obj = record;
      for (const part of path.slice(0, -1)) obj = obj[part] ||= {};
      obj[path.at(-1)] = structuredClone(value);
    }
    for (const key of Object.keys(update.$unset || {})) delete record[key];
  };
  return {
    record,
    collection: { indexes: async () => [{ key: { orderid: 1 }, unique: true }] },
    findOne: async filter => matches(filter) ? doc() : null,
    find: filter => ({ sort: () => ({ limit: async () => matches(filter) ? [doc()] : [] }) }),
    findOneAndUpdate: async (filter, update) => { if (!matches(filter)) return null; apply(update); return doc(); },
    updateOne: async (filter, update) => { if (!matches(filter)) return { modifiedCount: 0 }; apply(update); return { modifiedCount: 1 }; },
    create: async data => { Object.assign(record, data); return doc(); },
  };
}

function harness({ patch, link = {}, payment = {}, mt5 } = {}) {
  const orders = store(patch); const credits = []; const alerts = [];
  const guard = createGuard({ orders, logger: { error() {} }, updateBalance: mt5 || (async options => { credits.push(options); return { retcode: "0 Done", ticket: "77" }; }) });
  const state = { link: { id: "plink_1", status: "completed", amount: 260000, currency: "VND", ...link }, payment: { id: "pay_1", status: "succeeded", amount: 260000, currency: "VND", ...payment }, created: [] };
  const client = {
    getPaymentLink: async id => ({ ...state.link, id }),
    getPayment: async id => ({ ...state.payment, id }),
    createPaymentLink: async (body, key) => { state.created.push({ body, key }); return { id: "plink_new", url: "https://floxymoney.com/pay/plink_new", status: "active", amount: body.amount, currency: body.currency, expires_at: "2026-10-22T12:00:00Z" }; },
  };
  const svc = createFloxyDeposit({ client, orders, runDeposit: guard.run, balanceWithClaim, fetchRate: async () => 26000,
    alert: async subject => { alerts.push(subject); }, logger: { log() {}, error() {} } });
  const event = (type = "payment.succeeded", object = { id: "pay_1" }) => svc.handleEvent({ id: "evt_1", type, data: { object } });
  return { orders, credits, alerts, state, client, svc, event };
}

test("webhook signature: valid accepted; tampered, wrong secret, stale or malformed rejected", () => {
  const body = '{"id":"evt_1","type":"payment.succeeded"}'; const now = 1_800_000_000;
  assert.equal(verifySignature(Buffer.from(body), sign(body, now), SECRET, now + 10), true);
  assert.equal(verifySignature(Buffer.from(body + " "), sign(body, now), SECRET, now), false);
  assert.equal(verifySignature(Buffer.from(body), sign(body, now, "other"), SECRET, now), false);
  assert.equal(verifySignature(Buffer.from(body), sign(body, now), SECRET, now + 300), false);
  assert.equal(verifySignature(Buffer.from(body), "t=abc,v1=zz", SECRET, now), false);
  assert.equal(verifySignature(Buffer.from(body), undefined, SECRET, now), false);
  assert.equal(verifySignature(body, sign(body, now), SECRET, now), false, "parsed (non-raw) body must not verify");
});

test("minimum is the USD 10 equivalent but never below Floxy's VND 100,000; USD rounds to cents", async () => {
  assert.equal(minimumVnd(26000), 260000);
  assert.equal(minimumVnd(25432.5), 254325);
  assert.equal(minimumVnd(10000), 100000);
  assert.equal(toUsd(260000, 26000), 10);
  assert.equal(toUsd(1000000, 26315.5), 38);
  await assert.rejects(fetchVndPerUsd({ http: { get: async () => ({ data: { result: "error" } }) } }), /rate unavailable/);
  await assert.rejects(fetchVndPerUsd({ http: { get: async () => ({ data: { result: "success", rates: { VND: 26 } } }) } }), /rate unavailable/);
  assert.equal(await fetchVndPerUsd({ http: { get: async () => ({ data: { result: "success", rates: { VND: 26300 } } }) } }), 26300);
});

test("repeated payment.succeeded webhooks credit the locked USD amount exactly once", async () => {
  const h = harness({ payment: { metadata: { order_id: "FLX1" } } });
  await h.event(); await h.event();
  assert.equal(h.credits.length, 1);
  assert.equal(h.credits[0].balance, "10.00"); assert.equal(h.credits[0].login, "1001");
  assert.equal(h.orders.record.status, "SUCCESS"); assert.equal(h.orders.record.creditedAmount, 10);
  assert.equal(h.orders.record.floxy.paymentId, "pay_1");
});

test("matching works by link id when the payment carries no metadata", async () => {
  const h = harness({ payment: { payment_link: "plink_1" } });
  const out = await h.event();
  assert.equal(out.result, "credited"); assert.equal(h.credits.length, 1);
});

test("an explicitly matched succeeded payment credits even if the link status lags", async () => {
  const h = harness({ link: { status: "active" }, payment: { metadata: { order_id: "FLX1" } } });
  assert.equal((await h.event()).result, "credited"); assert.equal(h.credits.length, 1);
});

test("amount or currency mismatch never credits and alerts support", async () => {
  for (const variant of [{ link: { amount: 1 } }, { link: { status: "active" }, payment: { metadata: { order_id: "FLX1" }, currency: "IDR" } }]) {
    const h = harness({ ...variant, payment: { metadata: { order_id: "FLX1" }, ...variant.payment } });
    assert.equal((await h.event()).result, "mismatch");
    assert.equal(h.credits.length, 0); assert.equal(h.orders.record.status, "PENDING"); assert.equal(h.alerts.length, 1);
  }
});

test("failed or expired links mark the order FAILED without credit", async () => {
  for (const status of ["failed", "expired"]) {
    const h = harness({ link: { status }, payment: { status: "failed", metadata: { order_id: "FLX1" } } });
    await h.event("payment.failed");
    assert.equal(h.credits.length, 0); assert.equal(h.orders.record.status, "FAILED");
  }
});

test("a failed payment event alone never credits an active link", async () => {
  const h = harness({ link: { status: "active" }, payment: { status: "failed", metadata: { order_id: "FLX1" } } });
  assert.equal((await h.event("payment.failed")).result, "pending"); assert.equal(h.credits.length, 0);
});

test("unmatched event sweeps recent pending orders: completed links credit, active ones do not", async () => {
  const paid = harness();
  await paid.event(); assert.equal(paid.credits.length, 1); assert.equal(paid.alerts.length, 0);
  const waiting = harness({ link: { status: "active" } });
  await waiting.event(); assert.equal(waiting.credits.length, 0);
  assert.equal(waiting.alerts.length, 1, "a succeeded payment that matched nothing alerts support");
});

test("non-payment events are ignored", async () => {
  const h = harness();
  assert.deepEqual(await h.event("refund.completed"), { handled: false }); assert.equal(h.credits.length, 0);
});

test("lost MT5 reply locks the order for review and alerts; retries cannot credit", async () => {
  let calls = 0;
  const h = harness({ payment: { metadata: { order_id: "FLX1" } }, mt5: async () => { calls++; throw new Error("reply lost"); } });
  await assert.rejects(h.event(), /reply lost/);
  assert.equal(h.orders.record.settlementAttempt.state, "review"); assert.equal(h.alerts.length, 1);
  await assert.rejects(h.event(), /requires reconciliation/); assert.equal(calls, 1);
});

test("createDeposit enforces the minimum, locks the rate and stores the link", async () => {
  const low = harness();
  const refused = await low.svc.createDeposit({ account: { _id: "a1", accountNo: 1001 }, vndAmount: 259999, makeOrderId: () => "FLX9" });
  assert.equal(refused.ok, false); assert.equal(refused.minVnd, 260000); assert.equal(low.state.created.length, 0);

  const h = harness({ patch: { floxy: undefined, status: undefined } });
  const out = await h.svc.createDeposit({ account: { _id: "a1", accountNo: 1001 }, vndAmount: 520000, makeOrderId: () => "FLX9" });
  assert.equal(out.ok, true); assert.equal(out.usdAmount, 20); assert.equal(out.url, "https://floxymoney.com/pay/plink_new");
  assert.deepEqual(h.state.created[0], { key: "FLX9", body: { type: "fixed_amount", amount: 520000, currency: "VND", description: "BillionDollarFX deposit FLX9", metadata: { order_id: "FLX9", account_no: "1001" } } });
  assert.equal(h.orders.record.amount, 20); assert.equal(h.orders.record.floxy.linkId, "plink_new"); assert.equal(h.orders.record.floxy.vndPerUsd, 26000);
});

test("an unexpected link response is refused and the failing fields are recorded", async () => {
  const h = harness({ patch: { floxy: undefined } });
  h.client.createPaymentLink = async () => ({ data: "sealed-response" });
  const out = await h.svc.createDeposit({ account: { _id: "a1", accountNo: 1001 }, vndAmount: 300000, makeOrderId: () => "FLX9" });
  assert.equal(out.ok, false); assert.equal(out.status, 502); assert.equal(h.orders.record.status, "FAILED");
  assert.match(h.orders.record.comment, /\(id, url, amount, currency\)/);
});

test("createDeposit marks the order FAILED when Floxy refuses the link", async () => {
  const h = harness({ patch: { floxy: undefined } });
  h.client.createPaymentLink = async () => { const e = new Error("refused"); e.code = "amount_out_of_range"; throw e; };
  const out = await h.svc.createDeposit({ account: { _id: "a1", accountNo: 1001 }, vndAmount: 300000, makeOrderId: () => "FLX9" });
  assert.equal(out.ok, false); assert.equal(out.status, 400); assert.equal(h.orders.record.status, "FAILED");
});
