const { createHash, randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const Lead = require("../models/CrmLead");
const Call = require("../models/CrmCall");
const AssignmentLock = require("../models/CrmAssignmentLock");
const Staff = require("../models/AdminAccount");
const User = require("../models/User");
const Account = require("../models/account.model");
const Order = require("../models/Order");
const identity = require("../utils/registrationIdentity");

const TARGET = 300;
const DAY_MS = 86_400_000;
const DUBAI_OFFSET = 4 * 3_600_000;
const OUTCOMES = ["no_answer", "busy", "wrong_number", "connected", "not_interested", "qualified", "do_not_call"];
const CLOSED = new Set(["wrong_number", "not_interested", "do_not_call"]);
const staffFilter = { enabled: true, role: "manager", invitedBy: { $ne: null }, permissions: "crm" };
const bankFilter = { assignedTo: null, assignmentPending: false, status: "new" };
const objectIdPattern = /^[a-f\d]{24}$/i;
const requestIdPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

class CrmError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clean(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asId(value) {
  if (!objectIdPattern.test(String(value || ""))) throw new CrmError(400, "Invalid CRM record ID.");
  return new mongoose.Types.ObjectId(value);
}

function assertRequestId(value) {
  if (typeof value !== "string" || !requestIdPattern.test(value)) throw new CrmError(400, "Invalid request ID.");
}

function dubaiDay(date, now = new Date()) {
  const day = date || new Date(now.getTime() + DUBAI_OFFSET).toISOString().slice(0, 10);
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new CrmError(400, "Choose a valid Dubai date.");
  const start = new Date(day + "T00:00:00+04:00");
  if (!Number.isFinite(+start) || new Date(+start + DUBAI_OFFSET).toISOString().slice(0, 10) !== day) {
    throw new CrmError(400, "Choose a valid Dubai date.");
  }
  return { day, start, end: new Date(+start + DAY_MS) };
}

function staffScope(principal) {
  return principal.adminRole === "owner" ? {} : { assignedTo: asId(principal.id) };
}

function readyFilter(now) {
  return { $or: [{ status: "new" }, { status: "follow_up", followUpAt: { $lte: now } }] };
}

function pageNumber(value) {
  return Math.min(1_000_000, Math.max(1, Number.parseInt(value, 10) || 1));
}

function activeStaff() {
  return Staff.find(staffFilter).select("_id fullName email crmHashmiAgentId").sort({ fullName: 1, _id: 1 }).lean();
}

function staffKeys(staff) {
  const keys = new Map();
  for (const agent of staff) {
    for (const key of new Set([agent.email, agent.fullName].filter(Boolean).map(value => value.trim().toLowerCase()))) {
      keys.set(key, keys.has(key) ? null : agent);
    }
  }
  return keys;
}

function formatLead(lead) {
  return {
    id: String(lead._id),
    leadId: lead.leadId,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    source: lead.source,
    assignedTo: lead.assignedTo,
    assignedAt: lead.assignedAt,
    assignmentPending: lead.assignmentPending,
    originalAgent: lead.originalAgent,
    status: lead.status,
    followUpAt: lead.followUpAt,
    outcome: lead.lastOutcome,
    note: lead.lastNote,
    lastCallId: lead.dialRequest?.callId,
  };
}

async function insertNew(model, operations) {
  await model.init();
  try {
    return (await model.bulkWrite(operations, { ordered: false })).upsertedCount;
  } catch (error) {
    if (!error.writeErrors?.length || error.writeErrors.some(item => item.code !== 11000) || !error.result) throw error;
    return error.result.upsertedCount;
  }
}

async function importLeads(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new CrmError(400, "Upload up to 100 lead rows per request.");
  }
  const agents = staffKeys(await activeStaff());
  const explicitIds = rows.map(row => clean(row?.clientId, 100)).filter(value => objectIdPattern.test(value));
  const clients = explicitIds.length
    ? await User.find({ _id: { $in: explicitIds }, isVerified: true }).select("phone").lean()
    : [];
  const clientPhone = new Map(clients.map(client => [String(client._id), identity.normalizePhone(client.phone)]));
  const now = new Date();
  const operations = [];
  const rejected = [];
  const seen = new Set();
  let duplicates = 0;
  for (const [index, row] of rows.entries()) {
    const line = Number.isSafeInteger(row?.row) && row.row > 0 ? row.row : index + 2;
    const phone = identity.normalizePhone(clean(row?.phone, 50));
    if (!phone) {
      rejected.push({ row: line, reason: "Enter a valid phone number with country code." });
      continue;
    }
    const rawLeadId = typeof row?.leadId === "string" ? row.leadId.trim() : "";
    if (rawLeadId.length > 100) {
      rejected.push({ row: line, reason: "Lead ID is too long." });
      continue;
    }
    if (seen.has(phone)) {
      duplicates++;
      continue;
    }
    const originalAgent = clean(row?.creditedAgent, 254).toLowerCase();
    const agent = agents.get(originalAgent);
    const clientId = clean(row?.clientId, 100);
    const assignedDay = clean(row?.assignedDate, 25);
    let assignedAt = agent ? now : null;
    if (assignedDay && originalAgent) {
      try { assignedAt = dubaiDay(assignedDay).start; }
      catch {
        rejected.push({ row: line, reason: "Assigned date must be YYYY-MM-DD." });
        continue;
      }
    }
    seen.add(phone);
    operations.push({ updateOne: {
      filter: { phone },
      update: { $setOnInsert: {
        leadId: rawLeadId || "BDFX-" + randomUUID(),
        phone,
        name: clean(row?.name, 150),
        email: clean(row?.email, 254).toLowerCase(),
        source: clean(row?.source, 100) || "Upload",
        lastNote: clean(row?.note, 1500),
        originalAgent,
        assignedTo: agent?._id || null,
        assignedAt,
        assignmentPending: Boolean(originalAgent && !agent),
        clientId: clientPhone.get(clientId) === phone ? clientId : null,
        status: row?.doNotCall === true ? "closed" : "new",
        lastOutcome: row?.doNotCall === true ? "do_not_call" : undefined,
        createdAt: now,
        updatedAt: now,
      } },
      upsert: true,
      timestamps: false,
    } });
  }
  if (!operations.length) return { imported: 0, duplicates, rejected };
  const imported = await insertNew(Lead, operations);
  return { imported, duplicates: duplicates + operations.length - imported, rejected };
}

function parseTime(value) {
  const raw = clean(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const time = new Date(raw);
  return Number.isFinite(+time) ? time : null;
}

function leadOutcomeUpdate(event) {
  const status = CLOSED.has(event.outcome) ? "closed" : event.followUpAt ? "follow_up" : event.outcome === "qualified" ? "qualified" : "worked";
  const keepsOptOut = event.outcome === "do_not_call" ? {} : {
    lastOutcome: { $ne: "do_not_call" },
    $or: [{ lastOutcomeAt: null }, { lastOutcomeAt: { $lte: event.occurredAt } }],
  };
  return {
    filter: { _id: event.lead, ...keepsOptOut },
    update: { $set: { status, followUpAt: event.followUpAt, lastOutcome: event.outcome, lastNote: event.note, lastOutcomeAt: event.occurredAt } },
  };
}

async function importOutcomes(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    throw new CrmError(400, "Upload up to 100 call rows per request.");
  }
  const [staff, matched] = await Promise.all([
    activeStaff(),
    Lead.find({ leadId: { $in: rows.map(row => clean(row?.leadId, 100)) } }).select("_id leadId").lean(),
  ]);
  const names = staffKeys(staff);
  const leads = new Map(matched.map(lead => [lead.leadId, lead._id]));
  const rejected = [];
  const operations = [];
  for (const [index, row] of rows.entries()) {
    const line = Number.isSafeInteger(row?.row) && row.row > 0 ? row.row : index + 2;
    const lead = leads.get(clean(row?.leadId, 100));
    const agent = names.get(clean(row?.caller, 254).toLowerCase())?._id;
    const occurredAt = parseTime(row?.occurredAt);
    const outcome = row?.outcome;
    const followUpAt = row?.followUpAt && !CLOSED.has(outcome) ? parseTime(row.followUpAt) : null;
    if (!lead || !agent || !occurredAt || !OUTCOMES.includes(outcome) || (row.followUpAt && !CLOSED.has(outcome) && !followUpAt)) {
      rejected.push({ row: line, reason: "Match the Lead ID and CRM caller and check the call time, outcome and callback date." });
      continue;
    }
    const callId = clean(row?.callId, 120);
    const providerCallId = /^[a-z\d_-]{1,120}$/i.test(callId) ? callId : undefined;
    const fingerprint = JSON.stringify([String(lead), String(agent), occurredAt.toISOString(), outcome, providerCallId || ""]);
    const eventKey = "import:" + createHash("sha256").update(fingerprint).digest("hex");
    const event = { kind: "outcome", agent, lead, occurredAt, outcome, followUpAt,
      note: clean(row?.note, 1500), ...(providerCallId ? { providerCallId } : {}) };
    operations.push({ updateOne: { filter: { eventKey }, update: { $setOnInsert: event }, upsert: true, timestamps: false } });
  }
  if (!operations.length) return { imported: 0, duplicates: 0, rejected };
  const imported = await insertNew(Call, operations);
  const persisted = await Call.find({ eventKey: { $in: operations.map(item => item.updateOne.filter.eventKey) } }).lean();
  const latest = new Map();
  for (const event of persisted) {
    const key = String(event.lead);
    const previous = latest.get(key);
    if (!previous || event.outcome === "do_not_call" ||
        (previous.outcome !== "do_not_call" && +previous.occurredAt <= +event.occurredAt)) latest.set(key, event);
  }
  await Lead.bulkWrite([...latest.values()].map(event => ({ updateOne: leadOutcomeUpdate(event) })), { ordered: false });
  return { imported, duplicates: operations.length - imported, rejected };
}

async function progress(ids, date = dubaiDay(), now = new Date()) {
  const [queues, counts] = await Promise.all([
    Lead.aggregate([
      { $match: { assignedTo: { $in: ids }, ...readyFilter(now) } },
      { $group: { _id: "$assignedTo", ready: { $sum: 1 } } },
    ]),
    Call.aggregate([
      { $match: { agent: { $in: ids }, occurredAt: { $gte: date.start, $lt: date.end } } },
      { $group: {
        _id: "$agent",
        verified: { $sum: { $cond: [{ $and: [{ $eq: ["$kind", "hashmi"] }, "$attempted"] }, 1, 0] } },
        connected: { $sum: { $cond: [{ $and: [{ $eq: ["$kind", "hashmi"] }, "$connected"] }, 1, 0] } },
        logged: { $sum: { $cond: [{ $eq: ["$kind", "outcome"] }, 1, 0] } },
        talkSeconds: { $sum: { $cond: [{ $eq: ["$kind", "hashmi"] }, "$talkSeconds", 0] } },
      } },
    ]),
  ]);
  const byQueue = new Map(queues.map(item => [String(item._id), item.ready]));
  const byCall = new Map(counts.map(item => [String(item._id), item]));
  return new Map(ids.map(id => {
    const key = String(id);
    const { verified = 0, connected = 0, logged = 0, talkSeconds = 0 } = byCall.get(key) || {};
    return [key, { ready: byQueue.get(key) || 0, verified, connected, logged, talkSeconds }];
  }));
}

function planAssignments(staff, stats, available) {
  const slots = staff.map(agent => {
    const { verified = 0, ready = 0 } = stats.get(String(agent._id)) || {};
    return { agent: agent._id, covered: verified + ready };
  });
  const plan = [];
  for (const lead of available) {
    const next = slots.reduce((best, seat) => !best || seat.covered < best.covered ? seat : best, null);
    if (!next || next.covered >= TARGET) break;
    plan.push({ lead: lead._id, agent: next.agent });
    next.covered++;
  }
  return plan;
}

async function distribute() {
  const now = new Date();
  const token = randomUUID();
  const lock = { _id: "leads" };
  try {
    await AssignmentLock.updateOne({ ...lock, expiresAt: { $lte: now } },
      { $set: { token, expiresAt: new Date(+now + 60_000) } }, { upsert: true });
  } catch (error) {
    if (error.code === 11000) return { assigned: 0, busy: true };
    throw error;
  }
  try {
    const staff = await activeStaff();
    if (!staff.length) return { assigned: 0 };
    const keys = staffKeys(staff);
    const aliasUpdates = [...keys].flatMap(([key, agent]) => agent ? [{
      updateMany: {
        filter: { assignedTo: null, assignmentPending: true, originalAgent: key },
        update: [{ $set: { assignedTo: agent._id, assignmentPending: false, assignedAt: { $ifNull: ["$assignedAt", now] } } }],
      },
    }] : []);
    const credited = aliasUpdates.length ? (await Lead.bulkWrite(aliasUpdates, { ordered: false })).modifiedCount : 0;
    const stats = await progress(staff.map(agent => agent._id), dubaiDay(undefined, now), now);
    const capacity = [...stats.values()].reduce((sum, item) => sum + Math.max(0, TARGET - item.ready - item.verified), 0);
    if (!capacity) return { assigned: credited };
    const available = await Lead.find(bankFilter).sort({ createdAt: 1, _id: 1 }).limit(capacity).select("_id").lean();
    const plan = planAssignments(staff, stats, available);
    if (!plan.length) return { assigned: credited };
    const result = await Lead.bulkWrite(plan.map(({ lead, agent }) => ({
      updateOne: { filter: { ...bankFilter, _id: lead }, update: { $set: { assignedTo: agent, assignedAt: now } } },
    })), { ordered: false });
    return { assigned: credited + result.modifiedCount };
  } finally {
    await AssignmentLock.deleteOne({ ...lock, token });
  }
}

async function overview(principal, day) {
  const date = dubaiDay(day);
  const owner = principal.adminRole === "owner";
  const staff = owner ? await activeStaff() : await Staff.find(staffFilter).where("_id").equals(principal.id)
    .select("_id fullName crmHashmiAgentId").lean();
  const [stats, bank, pending] = await Promise.all([
    progress(staff.map(agent => agent._id), date),
    owner ? Lead.countDocuments(bankFilter) : null,
    owner ? Lead.countDocuments({ assignmentPending: true }) : null,
  ]);
  return {
    day: date.day,
    target: TARGET,
    owner,
    bank,
    pending,
    agents: staff.map(agent => ({
      id: String(agent._id),
      name: agent.fullName || agent.email,
      hashmiId: agent.crmHashmiAgentId || "",
      ...stats.get(String(agent._id)),
    })),
  };
}

function searchFilter(value) {
  const keyword = clean(value, 80);
  if (!keyword) return {};
  const escaped = keyword.replace(/[.*+?^\u0024{}()|[\]\\]/g, "\\$&");
  return { $or: ["name", "phone", "leadId"].map(key => ({ [key]: { $regex: escaped, $options: "i" } })) };
}

function leadFilter(principal, query) {
  const scope = staffScope(principal);
  if (principal.adminRole === "owner" && query.agent) scope.assignedTo = asId(query.agent);
  return { $and: [scope, searchFilter(query.search)] };
}

async function listLeads(principal, query) {
  const page = pageNumber(query.page);
  const limit = 50;
  const filter = leadFilter(principal, query);
  if (query.view === "queue") filter.$and.push(readyFilter(new Date()));
  const [rows, total] = await Promise.all([
    Lead.find(filter).sort({ status: 1, followUpAt: 1, createdAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
    Lead.countDocuments(filter),
  ]);
  return { rows: rows.map(formatLead), page, limit, total };
}

async function listClients(principal, query) {
  const page = pageNumber(query.page);
  const limit = 50;
  const [result] = await Lead.aggregate([
    { $match: leadFilter(principal, query) },
    { $lookup: {
      from: User.collection.name,
      let: { phone: "$phone", explicit: "$clientId", assignedAt: "$assignedAt" },
      pipeline: [
        { $match: { isVerified: true, $expr: { $or: [
          { $eq: ["$_id", "$$explicit"] },
          { $and: [
            { $eq: ["$phone", "$$phone"] },
            { $ne: ["$$assignedAt", null] },
            { $gte: ["$createdAt", "$$assignedAt"] },
          ] },
        ] } } },
        { $project: { fullName: 1, isKycVerified: 1, createdAt: 1, emailVerifiedAt: 1 } },
        { $limit: 2 },
      ],
      as: "client",
    } },
    { $match: { "client.0": { $exists: true }, "client.1": { $exists: false } } },
    { $unwind: "$client" },
    { $sort: { "client.createdAt": -1, _id: 1 } },
    { $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: "count" }] } },
  ]);
  const accounts = result.rows.length ? await Account.find({
    user: { $in: result.rows.map(lead => lead.client._id) }, accountType: "LIVE",
  }).select("user accountNo").lean() : [];
  const deposits = accounts.length ? await Order.find({
    status: "SUCCESS",
    $or: [{ account: { $in: accounts.map(item => item._id) } }, { accountNo: { $in: accounts.map(item => String(item.accountNo)) } }],
  }).select("account accountNo").lean() : [];
  const depositedAccounts = new Set(deposits.flatMap(item => [String(item.account), String(item.accountNo)]));
  const depositors = new Set(accounts.filter(item => depositedAccounts.has(String(item._id)) || depositedAccounts.has(String(item.accountNo))).map(item => String(item.user)));
  const rows = result.rows.map(lead => ({
    ...formatLead(lead),
    client: { id: String(lead.client._id), name: lead.client.fullName, registeredAt: lead.client.createdAt,
      kycApproved: lead.client.isKycVerified === true, firstDeposit: depositors.has(String(lead.client._id)) },
  }));
  return { rows, total: result.total[0]?.count || 0, page, limit };
}

async function recordOutcome(principal, leadId, body) {
  const agent = asId(principal.id);
  const id = asId(leadId);
  const outcome = body?.outcome;
  if (!OUTCOMES.includes(outcome)) throw new CrmError(400, "Choose a call outcome.");
  assertRequestId(body.requestId);
  const rawCallback = clean(body.followUpAt, 40);
  const followUpAt = rawCallback ? parseTime(rawCallback) : null;
  if (rawCallback && (!followUpAt || CLOSED.has(outcome))) {
    throw new CrmError(400, "Choose a callback date for an open lead.");
  }
  const current = await Lead.findOne({ _id: id, assignedTo: agent }).select("lastOutcome").lean();
  if (!current) throw new CrmError(404, "Assigned lead not found.");
  if (current.lastOutcome === "do_not_call" && outcome !== "do_not_call") {
    throw new CrmError(409, "This lead is marked Do not call.");
  }
  const key = "outcome:" + body.requestId;
  const fields = { kind: "outcome", agent, lead: id, occurredAt: new Date(), outcome, note: clean(body.note, 1500), followUpAt };
  await Call.init();
  let event;
  try {
    event = await Call.findOneAndUpdate({ eventKey: key }, { $setOnInsert: fields }, { upsert: true, new: true }).lean();
  } catch (error) {
    if (error.code !== 11000) throw error;
    event = await Call.findOne({ eventKey: key }).lean();
  }
  if (!event || String(event.agent) !== String(agent) || String(event.lead) !== String(id)) {
    throw new CrmError(409, "This call entry already belongs to another lead.");
  }
  const leadUpdate = leadOutcomeUpdate(event);
  await Lead.updateOne({ ...leadUpdate.filter, assignedTo: agent }, leadUpdate.update);
  return { saved: true, status: leadUpdate.update.$set.status };
}

async function history(principal, id) {
  const lead = await Lead.findOne({ _id: asId(id), ...staffScope(principal) }).select("_id").lean();
  if (!lead) throw new CrmError(404, "Lead not found.");
  return Call.find({ lead: lead._id }).select("kind occurredAt outcome note followUpAt attempted connected talkSeconds").sort({ occurredAt: -1 }).limit(50).lean();
}

module.exports = { TARGET, CrmError, staffFilter, asId, assertRequestId, dubaiDay, staffScope, importLeads, importOutcomes,
  distribute, overview, listLeads, listClients, recordOutcome, history, planAssignments };
