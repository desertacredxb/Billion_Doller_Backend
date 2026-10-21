const test = require("node:test");
const assert = require("node:assert/strict");
const { checkSupportChatStorage } = require("../services/supportChatReadiness.service");
function storage(initial = [], fail = false) {
  const indexes = structuredClone(initial), writes = [];
  return { writes, indexes, db: { readyState: 1 }, init: () => assert.fail("cached model init must not be used"), collection: {
    indexes: async () => { if (!indexes.length) throw Object.assign(new Error("No collection yet"), { code: 26 }); return indexes; },
    createIndex: async (key, options) => { writes.push({ key, options }); if (fail) throw Object.assign(new Error("Index unavailable"), { code: 11000 }); indexes.push({ key, ...options }); },
  } };
}
test("chat readiness recovers a new connected collection without awaiting a retained Model.init rejection", async () => {
  const sessions = storage(); await checkSupportChatStorage({ sessions });
  assert.equal(sessions.writes.length, 4);
  assert.ok(sessions.indexes.some(index => index.unique === true && index.key.publicId === 1));
  assert.ok(sessions.indexes.some(index => index.expireAfterSeconds === 0 && index.key.expiresAt === 1));
  await checkSupportChatStorage({ sessions }); assert.equal(sessions.writes.length, 4);
});
test("disconnection and index creation failure prevent an unsafe saved-chat storage readiness result", async () => {
  const disconnected = storage(); disconnected.db.readyState = 0;
  await assert.rejects(checkSupportChatStorage({ sessions: disconnected }), /unavailable/); assert.equal(disconnected.writes.length, 0);
  const failed = storage([], true); await assert.rejects(checkSupportChatStorage({ sessions: failed }));
  assert.equal(failed.writes.length, 1);
});
test("partial uniqueness and partial expiration do not count as safe full-session storage indexes", async () => {
  const sessions = storage([
    { key: { publicId: 1 }, unique: true, partialFilterExpression: { enabled: true } },
    { key: { expiresAt: 1 }, expireAfterSeconds: 0, partialFilterExpression: { enabled: true } },
  ]);
  await checkSupportChatStorage({ sessions });
  assert.ok(sessions.writes.some(value => value.options.unique === true));
  assert.ok(sessions.writes.some(value => value.options.expireAfterSeconds === 0));
});
