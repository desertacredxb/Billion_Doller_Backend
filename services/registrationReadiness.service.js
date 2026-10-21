const User = require("../models/User");
const KEYS = ["registrationEmailKey", "registrationPhoneKey"];

async function checkRegistrationStorage({ users = User } = {}) {
  if (users.db.readyState !== 1) throw new Error("Registration storage is unavailable.");
  let indexes = await users.collection.indexes();
  for (const key of KEYS) {
    const valid = index => index.unique === true && !index.sparse && !index.buildUUID &&
      Object.keys(index.key).length === 1 && index.key[key] === 1 &&
      index.partialFilterExpression?.[key]?.$type === "string" && Object.keys(index.partialFilterExpression).length === 1;
    if (!indexes.some(valid)) {
      await users.collection.createIndex({ [key]: 1 }, { name: `registration_${key}_unique`, unique: true,
        partialFilterExpression: { [key]: { $type: "string" } } });
      indexes = await users.collection.indexes();
    }
    if (!indexes.some(valid)) throw new Error("Registration identity indexes are unavailable.");
  }
  // Allow two separate five-minute codes without changing customer dates.
  const pendingTtl = index => index.key?.createdAt === 1 && Object.keys(index.key).length === 1 &&
    index.partialFilterExpression?.isVerified === false && Object.keys(index.partialFilterExpression).length === 1 &&
    Number.isFinite(index.expireAfterSeconds);
  let ttl = indexes.find(pendingTtl);
  if (!ttl) {
    await users.collection.createIndex({ createdAt: 1 }, { name: "registration_pending_ttl", expireAfterSeconds: 900,
      partialFilterExpression: { isVerified: false } });
    indexes = await users.collection.indexes();
    ttl = indexes.find(pendingTtl);
  }
  if (!ttl) throw new Error("Registration expiration index is unavailable.");
  if (ttl && ttl.expireAfterSeconds < 900) {
    await users.db.db.command({ collMod: users.collection.collectionName, index: { name: ttl.name, expireAfterSeconds: 900 } });
  }
  indexes = await users.collection.indexes();
  if (!indexes.some(index => pendingTtl(index) && index.expireAfterSeconds >= 900)) throw new Error("Registration expiration window is unavailable.");
}

let ready;
async function ensureRegistrationStorage() {
  if (User.db.readyState !== 1) { ready = null; throw new Error("Registration storage is unavailable."); }
  if (!ready) ready = checkRegistrationStorage().catch(error => { ready = null; throw error; });
  return ready;
}
module.exports = { checkRegistrationStorage, ensureRegistrationStorage };
