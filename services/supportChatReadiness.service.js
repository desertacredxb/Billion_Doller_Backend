const Session = require("../models/SupportChatSession");

async function checkSupportChatStorage({ sessions = Session } = {}) {
  if (sessions.db.readyState !== 1) throw new Error("Support chat storage is unavailable.");
  // Model.init() may retain an auto-create error from before the connection.
  // Inspect the connected collection, as registration/Veriff readiness do.
  const collection = sessions.collection;
  let indexes;
  try { indexes = await collection.indexes(); }
  catch (error) { if (error.code !== 26 && error.codeName !== "NamespaceNotFound") throw error; indexes = []; }
  const unique = index => index.unique === true && !index.sparse && !index.partialFilterExpression && !index.buildUUID &&
    Object.keys(index.key).length === 1 && index.key.publicId === 1;
  const expiry = index => !index.partialFilterExpression && !index.buildUUID && index.expireAfterSeconds === 0 &&
    Object.keys(index.key).length === 1 && index.key.expiresAt === 1;
  if (!indexes.some(unique)) await collection.createIndex({ publicId: 1 }, { name: "publicId_1", unique: true });
  if (!indexes.some(expiry)) await collection.createIndex({ expiresAt: 1 }, { name: "expiresAt_1", expireAfterSeconds: 0 });
  if (!indexes.some(index => index.key.createdAt === -1 && index.key._id === -1)) await collection.createIndex({ createdAt: -1, _id: -1 }, { name: "createdAt_-1__id_-1" });
  if (!indexes.some(index => index.key.lastActiveAt === -1)) await collection.createIndex({ lastActiveAt: -1 }, { name: "lastActiveAt_-1" });
  indexes = await collection.indexes();
  if (!indexes.some(unique) || !indexes.some(expiry)) throw new Error("Support chat storage indexes are unavailable.");
}
let ready;
async function ensureSupportChatStorage() {
  if (Session.db.readyState !== 1) { ready = null; throw new Error("Support chat storage is unavailable."); }
  if (!ready) ready = checkSupportChatStorage().catch(error => { ready = null; throw error; });
  return ready;
}
module.exports = { checkSupportChatStorage, ensureSupportChatStorage };
