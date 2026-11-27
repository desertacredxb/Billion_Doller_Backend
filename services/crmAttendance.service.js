const mongoose = require("mongoose");
const Staff = require("../models/AdminAccount");
const Shift = require("../models/CrmShift");

async function checkIn(agent, version, start, end) {
  const _id = String(agent) + ":" + version;
  // The expiry is an upper bound even if the browser disappears without signing out.
  try {
    await Shift.updateOne({ _id }, { $setOnInsert: { agent, version, start, end, reason: "expiry" } }, { upsert: true });
  } catch (err) { if (err.code !== 11000) throw err; }
  await Shift.updateMany({ agent, version: { $lt: version }, end: { $gt: start } }, { $set: { end: start, reason: "new_login" } });
}

async function checkOut(id, token, now = new Date()) {
  const start = new Date(token.iat * 1000);
  await mongoose.connection.transaction(async session => {
    const result = await Staff.updateOne({ _id: id, authVersion: token.version }, { $inc: { authVersion: 1 } }, { session });
    if (!result.modifiedCount) return;
    // Also close sessions issued just before attendance was deployed.
    await Shift.updateOne({ _id: String(id) + ":" + token.version }, {
      $setOnInsert: { agent: id, version: token.version, start },
      $set: { end: now, reason: "sign_out" },
    }, { upsert: true, session });
  });
}

function summarize(shifts, start, end, now = new Date()) {
  const byAgent = new Map();
  for (const shift of shifts) {
    const id = String(shift.agent);
    const from = Math.max(+shift.start, +start);
    const until = Math.min(+shift.end, +end, +now);
    if (from > until) continue;
    const value = byAgent.get(id) || { firstIn: new Date(from), lastOut: null, onDuty: false, milliseconds: 0, until: 0 };
    value.milliseconds += Math.max(0, until - Math.max(from, value.until));
    value.until = Math.max(until, value.until);
    value.onDuty ||= +shift.start <= +now && +now < +shift.end && +start <= +now && +now < +end;
    value.lastOut = value.onDuty ? null : new Date(value.until);
    byAgent.set(id, value);
  }
  return new Map([...byAgent].map(([id, row]) => [id, { firstIn: row.firstIn, lastOut: row.lastOut,
    onDuty: row.onDuty, seconds: Math.floor(row.milliseconds / 1000) }]));
}

async function report(ids, range, now = new Date()) {
  const shifts = await Shift.find({ agent: { $in: ids }, start: { $lt: range.end }, end: { $gt: range.start } }).sort({ start: 1 }).lean();
  return summarize(shifts, range.start, range.end, now);
}
module.exports = { checkIn, checkOut, report, summarize };
