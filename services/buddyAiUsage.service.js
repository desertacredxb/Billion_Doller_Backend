const mongoose = require("mongoose");
const DAILY_LIMIT = 200;
function createUsage({ connection = mongoose.connection, now = () => new Date() } = {}) {
  let ready;
  async function collection() {
    if (connection.readyState !== 1) { ready = null; throw new Error("AI usage storage unavailable"); }
    const store = connection.collection("buddy_ai_usage");
    if (!ready) ready = store.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(error => { ready = null; throw error; });
    await ready;
    return store;
  }
  return {
    async reserve() {
      const store = await collection(), at = now();
      try {
        const result = await store.findOneAndUpdate({ _id: "day:" + at.toISOString().slice(0, 10), count: { $lt: DAILY_LIMIT } },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(at.getTime() + 3 * 86400000) } },
          { upsert: true, returnDocument: "after", includeResultMetadata: false, writeConcern: { w: "majority", j: true } });
        return !!result && result.count <= DAILY_LIMIT;
      } catch (error) { if (error.code === 11000) return false; throw error; }
    },
    async claim(nonce, expiresAt) {
      const store = await collection();
      try {
        await store.insertOne({ _id: "use:" + nonce, expiresAt: new Date(expiresAt + 60000) }, { writeConcern: { w: "majority", j: true } });
        return true;
      } catch (error) { if (error.code === 11000) return false; throw error; }
    },
  };
}
module.exports = { createUsage, DAILY_LIMIT };
