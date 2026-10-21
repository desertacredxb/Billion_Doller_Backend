const test = require("node:test");
const assert = require("node:assert/strict");
const { createGuard, balanceWithClaim } = require("../services/depositCredit.service");

function storage(patch = {}) {
  const record = { _id: "db1", orderid: "ORD1", accountNo: "1001", provider: "CREGIS", amount: 100, creditedAmount: 0, status: "PENDING", ...patch };
  function matches(filter) {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = key.split(".").reduce((obj, key) => obj?.[key], record);
      return expected?.$ne ? actual !== expected.$ne : expected?.$nin ? !expected.$nin.includes(actual) : expected?.$in ? expected.$in.includes(actual) : actual === expected;
    });
  }
  const doc = () => ({ ...structuredClone(record), save: async function() { record.status = this.status; record.creditedAmount = this.creditedAmount; } });
  function apply(update) {
    for (const [key, value] of Object.entries(update.$set || {})) {
      const path = key.split("."); let obj = record;
      for (const part of path.slice(0, -1)) obj = obj[part] ||= {};
      obj[path.at(-1)] = structuredClone(value);
    }
    for (const key of Object.keys(update.$unset || {})) delete record[key];
  }
  return {
    record,
    collection: { indexes: async () => [{ key: { orderid: 1 }, unique: true }] },
    findOne: async filter => matches(filter) ? doc() : null,
    findOneAndUpdate: async (filter, update) => { if (!matches(filter)) return null; apply(update); return doc(); },
    updateOne: async (filter, update) => { if (!matches(filter)) return { modifiedCount: 0 }; apply(update); return { modifiedCount: 1 }; },
  };
}
function harness({ patch, updateBalance } = {}) {
  const orders = storage(patch); const credits = []; const errors = [];
  const guard = createGuard({ orders, updateBalance: updateBalance || (async options => { credits.push(options); return { retcode: "0 Done", ticket: "123" }; }), logger: { error: value => errors.push(value) } });
  const pay = (amount, status = "SUCCESS") => guard.run("ORD1", async order => {
    const result = await balanceWithClaim({ login: order.accountNo, type: 2, balance: amount, comment: "existing-provider-comment" });
    assert.equal(result.retcode, "0 Done");
    order.creditedAmount += Number(amount); order.status = status; await order.save();
  });
  return { orders, guard, credits, errors, pay };
}

test("repeated callbacks never submit another credit, including legacy successful orders", async () => {
  const h = harness(); await h.pay(100); await h.pay(100);
  assert.equal(h.credits.length, 1); assert.equal(h.orders.record.creditedAmount, 100);
  const legacy = harness({ patch: { status: "SUCCESS", creditedAmount: 0 } }); await legacy.pay(100);
  assert.equal(legacy.credits.length, 0);
});
test("simultaneous callbacks and reconciliation use one database claim", async () => {
  let release; let enter;
  const entered = new Promise(resolve => enter = resolve); const wait = new Promise(resolve => release = resolve);
  const credits = [];
  const h = harness({ updateBalance: async options => { credits.push(options); enter(); await wait; return { retcode: 0 }; } });
  const first = h.pay(100); await entered;
  await assert.rejects(h.pay(100), /processed or requires reconciliation/);
  release(); await first; await h.pay(100);
  assert.equal(credits.length, 1);
});
test("partial, repeated partial and top-up events use freshly claimed cumulative state", async () => {
  const h = harness();
  async function cumulative(total, status) {
    await h.guard.run("ORD1", async order => {
      const delta = total - order.creditedAmount;
      if (delta > 0) await balanceWithClaim({ login: order.accountNo, type: 2, balance: delta });
      order.creditedAmount = total; order.status = status; await order.save();
    });
  }
  await cumulative(25, "PARTIALLY_PAID"); await cumulative(25, "PARTIALLY_PAID"); await cumulative(105, "SUCCESS"); await cumulative(105, "SUCCESS");
  assert.deepEqual(h.credits.map(x => x.balance), [25, 80]); assert.equal(h.orders.record.creditedAmount, 105);
});
test("a lost MT5 reply leaves a persistent review claim and cannot auto-retry", async () => {
  let calls = 0;
  const h = harness({ updateBalance: async () => { calls++; throw new Error("reply lost"); } });
  await assert.rejects(h.pay(100), /reply lost/);
  assert.equal(h.orders.record.settlementAttempt.state, "review");
  await assert.rejects(h.pay(100), /processed or requires reconciliation/); assert.equal(calls, 1);
});
test("failure saving after a successful MT5 credit cannot lead to a second credit", async () => {
  const h = harness();
  await assert.rejects(h.guard.run("ORD1", async () => {
    await balanceWithClaim({ login: "1001", type: 2, balance: "100.00" }); throw new Error("save failed");
  }), /save failed/);
  assert.equal(h.orders.record.settlementAttempt.state, "review");
  await assert.rejects(h.pay(100)); assert.equal(h.credits.length, 1);
});
test("a persisted claim survives a restart and no balance call can run outside a claim", async () => {
  await assert.rejects(balanceWithClaim({ login: "1001", balance: 100 }), /claim is required/);
  for (const state of ["processing", "submitting", "review"]) {
    const h = harness({ patch: { settlementAttempt: { state, token: "old-worker" } } });
    await assert.rejects(h.pay(100)); assert.equal(h.credits.length, 0);
  }
});
test("validation/pre-credit failures release the claim, while an invalid MT5 result requires review", async () => {
  const h = harness();
  await assert.rejects(h.guard.run("ORD1", async () => { throw new Error("provider validation failed"); }));
  assert.equal(h.orders.record.settlementAttempt, undefined);
  await assert.rejects(h.guard.run("ORD1", async () => balanceWithClaim({ login: "another-account", type: 2, balance: 100 })));
  assert.equal(h.credits.length, 0);
  const bad = harness({ updateBalance: async () => ({ retcode: "01" }) }); await assert.rejects(bad.pay(100));
  assert.equal(bad.orders.record.settlementAttempt.state, "review");
});
test("one callback cannot issue two credits even before it saves status", async () => {
  const h = harness();
  await assert.rejects(h.guard.run("ORD1", async () => {
    await balanceWithClaim({ login: "1001", type: 2, balance: 100 });
    await balanceWithClaim({ login: "1001", type: 2, balance: 100 });
  }), /cannot submit two/);
  assert.equal(h.credits.length, 1); assert.equal(h.orders.record.settlementAttempt.state, "review");
});
test("missing or partial order uniqueness indexes block credit before a claim or balance call", async () => {
  for (const index of [{ key: { orderid: 1 } }, { key: { orderid: 1 }, unique: true, partialFilterExpression: { status: "PENDING" } }]) {
    const h = harness(); h.orders.collection.indexes = async () => [index];
    await assert.rejects(h.pay(100), /uniqueness index/);
    assert.equal(h.credits.length, 0); assert.equal(h.orders.record.settlementAttempt, undefined);
  }
});
test("closed gateways refuse deposits and callbacks without loading financial services", async () => {
  for (const [file, names] of [
    ["digipay", ["handleDigipayDeposit", "handlePaymentCallback"]],
    ["trustpay24", ["handleTrustpay24Deposit", "handleTrustpay24Callback"]],
    ["truepay9", ["handleTruepay9Callback"]],
  ]) {
    const controller = require(`../controllers/payments/${file}.controller`);
    for (const name of names) {
      const res = { status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; } };
      await controller[name]({ body: { amount: 100, transaction: { status: "completed" } } }, res);
      assert.equal(res.code, 410); assert.equal(res.value.status, "UNAVAILABLE");
    }
  }
});
test("all three active callback handlers use the same guard and repeated notices do not double credit", async () => {
  const Module = require("node:module");
  for (const [file, handler, payload, provider] of [
    ["rameePay", "handleRameeCallback", { data: "mock", agentCode: "mock" }, "RAMEE"],
    ["crypto", "handleCryptoCallback", { data: "mock", agentCode: "mock" }, "CRYPTO"],
    ["cregis", "handleCregisCallback", { event_type: "paid", data: JSON.stringify({ order_id: "ORD1", cregis_id: "po123", pay_amount: "100", pay_currency: "USDT" }) }, "CREGIS"],
  ]) {
    const h = harness({ patch: { provider, providerOrderId: "po123" } });
    const original = Module._load;
    const path = require.resolve(`../controllers/payments/${file}.controller`); delete require.cache[path];
    Module._load = function(request, ...args) {
      if (request === "../../services/depositCredit.service") return { runDeposit: h.guard.run, balanceWithClaim };
      if (request === "../../models/Order") return h.orders;
      if (request === "../../models/withdrawal") return { findOne: async () => null };
      if (request === "../../models/account.model") return { findOne: () => ({ populate: async () => null }) };
      if (request === "../../utils/rameeCrypto") return { decryptData: () => ({ merchantid: "ORD1", orderid: "ORD1", status: "SUCCESS", amount: "100", payAmount: "100" }), decryptDataCrypto: () => ({ orderid: "ORD1", status: "SUCCESS", amount: "100", payAmount: "100" }) };
      if (request === "../payout.controller") return { sendSuccessEmail: async () => {} };
      if (request === "../../utils/sendEmail") return async () => {};
      if (request === "./fetchRate") return async () => 1;
      return original.call(this, request, ...args);
    };
    let controller;
    try { controller = require(path); } finally { Module._load = original; }
    for (let i = 0; i < 2; i++) {
      const res = { status(code) { this.code = code; return this; }, json(value) { this.value = value; return this; }, send(value) { this.value = value; return this; } };
      await controller[handler]({ body: payload }, res);
      assert.equal(res.code, 200, file);
    }
    assert.equal(h.credits.length, 1, file); assert.equal(h.orders.record.creditedAmount, 100, file);
    assert.equal(h.orders.record.status, "SUCCESS", file);
  }
});
module.exports = { storage };
