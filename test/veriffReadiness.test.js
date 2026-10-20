const test = require("node:test");
const assert = require("node:assert/strict");
const { checkIBStorage, checkOnStartup } = require("../services/veriffReadiness.service");

function storage({ missingIndex = false, transactionError = false } = {}) {
  const calls = [];
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
  const brokers = { async init() {}, async listIndexes() {
    return (missingIndex ? ["referralCode"] : ["user", "referralCode"]).map(field => ({ key: { [field]: 1 }, unique: true, sparse: true }));
  }, findOne(filter) { assert.deepEqual(filter, { _id: null }); return query("ib-read"); } };
  return { users, brokers, calls };
}

test("storage preflight checks both indexes and aborts its read-only transaction", async () => {
  const db = storage();
  await checkIBStorage(db);
  assert.deepEqual(db.calls, ["start", "user-read", "ib-read", "abort", "end"]);
});

test("a missing IB uniqueness index blocks readiness before any transaction", async () => {
  const db = storage({ missingIndex: true });
  await assert.rejects(checkIBStorage(db), /unique indexes/);
  assert.deepEqual(db.calls, []);
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
