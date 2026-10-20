const test = require("node:test");
const assert = require("node:assert/strict");
const { checkIBStorage, checkOnStartup } = require("../services/veriffReadiness.service");

function storage({ missingIndex = false, createError = false, transactionError = false } = {}) {
  const calls = [];
  const fields = missingIndex ? ["referralCode"] : ["user", "referralCode"];
  const session = {
    startTransaction() { calls.push("start"); },
    async abortTransaction() { calls.push("abort"); },
    async endSession() { calls.push("end"); },
  };
  const query = name => ({ select(fields) {
    assert.equal(fields, "_id");
    return { session(value) {
      assert.equal(value, session);
      return { async lean() {
        calls.push(name);
        if (transactionError) throw Object.assign(new Error("Unsupported transactions; private connection details"), { code: 20 });
        return null;
      } };
    } };
  } });
  const users = { async startSession() { return session; }, findOne(filter) {
    assert.deepEqual(filter, { _id: null }); return query("user-read");
  } };
  const brokers = { async init() { throw new Error("Cached model initialization failure"); }, async listIndexes() {
    return fields.map(field => ({ key: { [field]: 1 }, unique: true, sparse: true }));
  }, collection: { async createIndex(key, options) {
    const field = Object.keys(key)[0];
    assert.deepEqual(options, { name: `veriff_${field}_unique_sparse`, unique: true, sparse: true });
    calls.push(`index-${field}`);
    if (createError) throw Object.assign(new Error("Duplicate private values"), { code: 11000 });
    fields.push(field);
  } }, findOne(filter) { assert.deepEqual(filter, { _id: null }); return query("ib-read"); } };
  return { users, brokers, calls };
}

test("storage preflight checks both indexes and aborts its read-only transaction", async () => {
  const db = storage();
  await checkIBStorage(db);
  assert.deepEqual(db.calls, ["start", "user-read", "ib-read", "abort", "end"]);
});

test("a missing IB uniqueness index is created without rebuilding existing indexes", async () => {
  const db = storage({ missingIndex: true });
  await checkIBStorage(db);
  assert.deepEqual(db.calls, ["index-user", "start", "user-read", "ib-read", "abort", "end"]);
});

test("duplicate data blocks a required unique index and prevents the transaction probe", async () => {
  const db = storage({ missingIndex: true, createError: true });
  await assert.rejects(checkIBStorage(db), error => error.readinessStage === "index_create_user" && error.mongoCode === 11000);
  assert.deepEqual(db.calls, ["index-user"]);
});

test("a failed transaction check always closes its session", async () => {
  const db = storage({ transactionError: true });
  await assert.rejects(checkIBStorage(db), error => error.readinessStage === "transaction" && error.mongoCode === 20);
  assert.deepEqual(db.calls, ["start", "user-read", "end"]);
});

test("startup blocks active IB automation on failed storage without logging private errors", async () => {
  const messages = [];
  const logger = { info(message) { messages.push(message); }, error(message) { messages.push(message); } };
  const env = { VERIFF_API_KEY: "synthetic-key", VERIFF_SHARED_SECRET: "synthetic-secret", VERIFF_ENABLED: "true", VERIFF_IB_AUTO_APPROVAL: "true" };
  const check = async () => { throw new Error("private connection details"); };
  await assert.rejects(checkOnStartup({ env, check, logger }), /not ready/);
  assert.equal(messages.length, 1);
  assert.equal(messages.join(" ").includes("private connection details"), false);
  await checkOnStartup({ env: { ...env, VERIFF_IB_AUTO_APPROVAL: "false" }, check, logger });
});

test("unconfigured installations skip the readiness probe", async () => {
  await checkOnStartup({ env: {}, check: async () => { throw new Error("Should not run"); } });
});
