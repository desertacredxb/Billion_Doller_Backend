const IB = require("../models/Broker.model");
const id = value => value == null ? "" : String(value);
const emailKey = value => typeof value === "string" ? value.trim().toLowerCase() : "";
async function withReferrerNames(documents, brokers = IB) {
  const users = documents.map(user => user.toJSON());
  const namesById = new Map(users.map(user => [id(user._id), user.fullName]));
  const namesByEmail = new Map(users.map(user => [emailKey(user.email), user.fullName]));
  const codes = [...new Set(users.map(user => user.referralCode).filter(code => typeof code === "string" && code.length > 0 && code.length <= 100))];
  const ids = [...new Set(users.map(user => id(user.referredByIB)).filter(value => /^[a-f\d]{24}$/i.test(value)))];
  if (!codes.length && !ids.length) return users;
  // One bounded lookup for all clients; never one network request per row.
  let list;
  try { list = await brokers.find({ $or: [...(codes.length ? [{ referralCode: { $in: codes } }] : []), ...(ids.length ? [{ _id: { $in: ids } }] : [])] })
    .select("_id user email referralCode").maxTimeMS(5000).lean(); }
  catch { console.error("User referral names temporarily unavailable."); list = []; }
  const byCode = new Map(list.filter(b => b.referralCode).map(b => [b.referralCode, b]));
  const byId = new Map(list.map(b => [id(b._id), b]));
  return users.map(user => {
    const broker = user.referredByIB ? byId.get(id(user.referredByIB)) : byCode.get(user.referralCode);
    const referredByName = broker ? namesById.get(id(broker.user)) || namesByEmail.get(emailKey(broker.email)) || "N/A" : "N/A";
    return { ...user, referredByName };
  });
}
module.exports = { withReferrerNames };
