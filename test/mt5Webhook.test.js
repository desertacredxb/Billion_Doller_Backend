const test = require("node:test");
const assert = require("node:assert/strict");
const Deal = require("../models/Deal.model");
const { receiveIbCommissionWebhook } = require("../controllers/mt5WebhookController");
const { calculateClientCommission } = require("../utils/commissionServiceV3");

function response() {
  return {
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("MT5 close-deal webhooks save the received login and retries do not double commission", async t => {
  const rows = new Map();
  const timestamp = Date.parse("2026-10-23T08:00:00Z") / 1000;
  t.mock.method(console, "error", () => {});
  t.mock.method(Deal, "findOneAndUpdate", async (filter, update, options) => {
    assert.deepEqual(filter, { order: "90001" });
    assert.equal(options.upsert, true);
    assert.equal(new Deal(update).validateSync(), undefined);
    rows.set(filter.order, structuredClone(update));
    return update;
  });
  t.mock.method(Deal, "find", filter => ({
    lean: async () => [...rows.values()].filter(row =>
      row.login === filter.login && row.entry === filter.entry &&
      filter.action.$in.includes(row.action) &&
      row.time >= filter.time.$gte && row.time <= filter.time.$lte),
  }));

  for (const [loginKey, orderKey] of [["Login", "Order"], ["LOGIN", "ORDER"], ["login", "order"]]) {
    const res = response();
    await receiveIbCommissionWebhook({ body: {
      [loginKey]: 90000, [orderKey]: 90001, Action: 0, Entry: 1,
      Time: timestamp, Symbol: "XAUUSD.lp", Volume: 10000, Profit: 0,
    } }, res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { success: true });
  }

  assert.equal(rows.size, 1);
  const saved = rows.get("90001");
  assert.equal(saved.login, "90000");
  assert.equal(saved.action, "0");
  assert.equal(saved.profit, "0");
  assert.equal(saved.raw.login, 90000);
  assert.equal(await calculateClientCommission("90000", "2026-10-23T00:00:00Z", "2026-10-24T00:00:00Z"), 3.96);
  assert.equal(await calculateClientCommission("90002", "2026-10-23T00:00:00Z", "2026-10-24T00:00:00Z"), 0);
});

test("MT5 webhooks missing a login or deal ticket do not write a record", async t => {
  const writes = t.mock.method(Deal, "findOneAndUpdate", async () => {});
  t.mock.method(console, "error", () => {});
  for (const body of [undefined, {}, { Login: 90000 }, { Order: 90001 }]) {
    const res = response();
    await receiveIbCommissionWebhook({ body }, res);
    assert.equal(res.code, 400);
    assert.deepEqual(res.body, { success: false, message: "Login and Order are required" });
  }
  assert.equal(writes.mock.callCount(), 0);
});

test("a failed MT5 webhook database write returns an error so the sender can retry", async t => {
  const writes = t.mock.method(Deal, "findOneAndUpdate", async () => { throw new Error("database unavailable"); });
  t.mock.method(console, "error", () => {});
  const res = response();
  await receiveIbCommissionWebhook({ body: { Login: 90000, Order: 90001 } }, res);
  assert.equal(writes.mock.callCount(), 1);
  assert.equal(res.code, 500);
  assert.deepEqual(res.body, { success: false, message: "Server error" });
});
