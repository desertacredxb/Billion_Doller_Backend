const crypto = require("node:crypto");
const { Account, Thread, Message } = require("../models/CrmInbox");
const Lead = require("../models/CrmLead");
const Staff = require("../models/AdminAccount");
const { CrmError, asId, assertRequestId, ensureCrmIndexes, staffFilter } = require("./crm.service");
const provider = require("./crmInboxProvider");
const hour = 3600000;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const pair = () => crypto.randomBytes(18).toString("hex");
const activeAgent = agent => Staff.exists({ _id: agent, ...staffFilter });
async function ready() {
  await Promise.all([Account, Thread, Message].map(ensureCrmIndexes));
}
async function leadFor(principal, id) {
  const scope = principal.adminRole === "owner" ? {} : { assignedTo: asId(principal.id) };
  const lead = await Lead.findOne({ _id: asId(id), ...scope }).select("phone assignedTo assignedAt lastOutcome status").lean();
  if (!lead)
    throw new CrmError(404, "Assigned lead not found.");
  return lead;
}
function mustWrite(principal, lead) {
  if (principal.adminRole === "owner" || !lead.assignedTo || String(lead.assignedTo) !== principal.id)
    throw new CrmError(403, "Only the assigned agent can reply.");
  if (lead.status === "closed" || ["do_not_call", "number_not_in_use"].includes(lead.lastOutcome))
    throw new CrmError(409, "Messaging is closed for this lead.");
}
async function begin(agent, channel) {
  await ready();
  const settings = provider.settings();
  if (!await activeAgent(agent))
    throw new CrmError(403, "Sign in with an active CRM agent account.");
  if (!["whatsapp", "telegram"].includes(channel) || !settings[channel])
    throw new CrmError(503, "The owner must finish provider setup first.");
  if (channel === "telegram") {
    const hook = await provider.telegram("getWebhookInfo", {});
    const expected = process.env.BDFX_INBOX_API_ORIGIN + "/api/crm/inbox/hooks/telegram";
    if (!hook.result?.url || hook.result.url !== expected)
      throw new CrmError(503, "Ask the owner to verify the Telegram bot webhook first.");
  }
  const token = pair();
  await Account.updateOne({ agent, channel }, { $set: { pairingHash: digest(token), pairingUntil: new Date(Date.now() + 10 * 60000), consentAt: new Date() } }, { upsert: true });
  return channel === "telegram" ? { url: "https://t.me/" + settings.bot + "?start=bdfx_" + token } : { token };
}
async function whatsappFinish(agent, { token, code, waba, phone }) {
  if (!provider.settings().whatsapp || !/^[a-f\d]{36}$/.test(token || "") || typeof code !== "string" || !code || code.length > 4096 || !/^\d{5,24}$/.test(waba || "") || !/^\+[1-9]\d{6,14}$/.test(phone || ""))
    throw new CrmError(400, "Restart WhatsApp Business connection.");
  const filter = { agent, channel: "whatsapp", pairingHash: digest(token), pairingUntil: { $gt: new Date() } };
  if (!await Account.exists(filter))
    throw new CrmError(409, "Connection expired. Start again.");
  const access = await provider.exchange(code, waba, phone);
  const update = { externalId: access.phoneId, connectionId: waba, secret: provider.seal(access.token), canReply: true, enabled: true, connectedAt: new Date() };
  if (await Account.exists({ channel: "whatsapp", externalId: access.phoneId, agent: { $ne: agent } }))
    throw new CrmError(409, "This number is already linked to another agent.");
  if (await Account.exists({ agent, channel: "whatsapp", externalId: { $type: "string", $ne: access.phoneId } }))
    throw new CrmError(409, "Disconnect your previous number first.");
  await provider.graph(waba + "/subscribed_apps", access.token, {});
  // A different account needs its own conversation namespace. Require disconnect before changing numbers.
  const result = await Account.updateOne({ ...filter, $or: [{ externalId: null }, { externalId: access.phoneId }] }, { $set: update, $unset: { pairingHash: "", pairingUntil: "" } });
  if (!result.matchedCount)
    throw new CrmError(409, "Disconnect the previous number before linking another one.");
}
async function saveInbound(account, thread, msg) {
  if (!msg.remoteId || !Number.isFinite(+msg.at) || msg.at < account.connectedAt)
    return;
  try {
    await Message.updateOne({ thread: thread._id, remoteId: msg.remoteId, state: { $ne: "deleted" } }, { $set: { ...msg, text: String(msg.text || "").slice(0, 8192), state: msg.outbound ? "sent" : "received" } }, { upsert: true });
  }
  catch (error) {
    if (error.code !== 11000)
      throw error;
    // An earlier deletion or a concurrent delivery already owns the provider message ID.
    return;
  }
  if (!msg.outbound)
    await Thread.updateOne({ _id: thread._id }, { $max: { lastIncoming: msg.at } });
}
async function whatsappEvent(body) {
  for (const entry of body.entry || [])
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (!["messages", "smb_message_echoes"].includes(change.field) || !v.metadata?.phone_number_id)
        continue;
      const a = await Account.findOne({ channel: "whatsapp", enabled: true, externalId: String(v.metadata.phone_number_id), connectionId: String(entry.id) }).lean();
      if (!a || !await activeAgent(a.agent))
        continue;
      const outbound = change.field === "smb_message_echoes";
      for (const m of (outbound ? v.message_echoes : v.messages) || []) {
        const peer = String(outbound ? m.to : m.from);
        if (!/^\d{7,15}$/.test(peer) || !m.id)
          continue;
        const at = new Date(Number(m.timestamp) * 1000);
        const lead = await Lead.findOne({ assignedTo: a.agent, phone: "+" + peer, assignedAt: { $lte: at } }).select("_id").lean();
        if (!lead || at < a.connectedAt)
          continue;
        const t = await Thread.findOneAndUpdate({ account: a._id, lead: lead._id }, { $setOnInsert: { agent: a.agent, channel: a.channel, peer } }, { upsert: true, new: true }).lean();
        await saveInbound(a, t, { outbound, at, remoteId: String(m.id), text: m.text?.body || m[m.type]?.caption || "[" + String(m.type || "attachment") + "]" });
      }
    }
}
async function telegramEvent(body) {
  const command = body.message;
  const start = command?.chat?.type === "private" && command.from?.id === command.chat.id && /^\/start bdfx_([a-f\d]{36})$/.exec(command.text || "");
  if (start) {
    // Linking the bot in Telegram settings after this step supplies a signed business connection.
    const externalId = String(command.from.id);
    await Account.updateOne({ channel: "telegram", pairingHash: digest(start[1]), pairingUntil: { $gt: new Date() }, $or: [{ externalId: null }, { externalId }] }, { $set: { externalId }, $unset: { pairingHash: "", pairingUntil: "" } });
    return;
  }
  const c = body.business_connection;
  if (c) {
    if (!c.user?.id || !c.id)
      return;
    const a = await Account.findOne({ channel: "telegram", externalId: String(c.user.id) }).lean();
    if (!a || (!c.is_enabled && a.connectionId !== c.id))
      return;
    await Account.updateOne({ _id: a._id }, { $set: { connectionId: c.id, enabled: !!c.is_enabled, canReply: !!c.rights?.can_reply, connectedAt: a.connectedAt || new Date() } });
    return;
  }
  const m = body.business_message || body.edited_business_message || body.deleted_business_messages;
  if (!m?.business_connection_id || m.chat?.type !== "private")
    return;
  const a = await Account.findOne({ channel: "telegram", enabled: true, connectionId: m.business_connection_id }).lean();
  if (!a || !await activeAgent(a.agent))
    return;
  const peer = String(m.chat.id);
  const outbound = String(m.from?.id) === a.externalId || !!m.sender_business_bot;
  const code = outbound && /^BDFX chat ([a-f\d]{36})$/.exec(m.text || "");
  if (code) {
    const t = await Thread.findOne({ account: a._id, pairingHash: digest(code[1]), pairingUntil: { $gt: new Date() } }).lean();
    if (t && await Lead.exists({ _id: t.lead, assignedTo: a.agent }))
      await Thread.updateOne({ _id: t._id, pairingHash: digest(code[1]), $or: [{ peer: null }, { peer }] }, { $set: { peer }, $unset: { pairingHash: "", pairingUntil: "" } });
    return;
  }
  const t = await Thread.findOne({ account: a._id, peer }).lean();
  if (!t || !await Lead.exists({ _id: t.lead, assignedTo: a.agent }))
    return;
  if (body.deleted_business_messages) {
    await Promise.all((m.message_ids || []).map(id => Message.updateOne({ thread: t._id, remoteId: String(id) }, { $set: { text: "Message deleted", state: "deleted" }, $setOnInsert: { at: new Date() } }, { upsert: true })));
    return;
  }
  await saveInbound(a, t, { at: new Date(m.date * 1000), outbound, remoteId: String(m.message_id), text: m.text || m.caption || "[Attachment]" });
}
async function telegramPair(principal, id) {
  const lead = await leadFor(principal, id);
  mustWrite(principal, lead);
  const a = await Account.findOne({ agent: principal.id, channel: "telegram", enabled: true }).lean();
  if (!a)
    throw new CrmError(409, "Connect your Telegram account first.");
  const token = pair();
  const t = await Thread.findOneAndUpdate({ account: a._id, lead: lead._id }, { $setOnInsert: { channel: "telegram", agent: a.agent }, $set: { pairingHash: digest(token), pairingUntil: new Date(Date.now() + 10 * 60000) } }, { upsert: true, new: true }).lean();
  if (t.peer)
    throw new CrmError(409, "Telegram is already linked for this lead.");
  return { code: "BDFX chat " + token };
}
async function history(principal, id) {
  const lead = await leadFor(principal, id);
  const scope = principal.adminRole === "owner" ? {} : { agent: asId(principal.id) };
  const threads = await Thread.find({ lead: lead._id, ...scope }).select("channel agent peer lastIncoming account").lean();
  return Promise.all(threads.filter(t => t.peer).map(async (t) => {
    const account = await Account.findById(t.account).select("enabled canReply").lean();
    const author = await Staff.findById(t.agent).select("fullName").lean();
    const messages = await Message.find({ thread: t._id, superseded: { $ne: true } }).select("at text outbound state").sort({ at: -1, _id: -1 }).limit(100).lean();
    return { id: t._id, channel: t.channel, agent: t.agent, agentName: author?.fullName || "Agent", canReply: principal.adminRole !== "owner" && lead.status !== "closed" && !!account?.enabled && !!account.canReply && +t.lastIncoming > Date.now() - 24 * hour, messages: messages.reverse() };
  }));
}
async function reply(principal, id, { thread, text, key }) {
  const lead = await leadFor(principal, id);
  mustWrite(principal, lead);
  assertRequestId(key);
  if (typeof text !== "string" || !text.trim() || text.length > 4000)
    throw new CrmError(400, "Enter a message of up to 4,000 characters.");
  const t = await Thread.findOne({ _id: asId(thread), lead: lead._id, agent: asId(principal.id), peer: { $type: "string" }, lastIncoming: { $gt: new Date(Date.now() - 24 * hour) } }).lean();
  if (!t)
    throw new CrmError(409, "Wait for a new client message to reopen replies.");
  const a = await Account.findOne({ _id: t.account, agent: principal.id, enabled: true, canReply: true }).select("+secret").lean();
  if (!a)
    throw new CrmError(409, "Reconnect your work account.");
  let item;
  try {
    item = await Message.create({ thread: t._id, key, text: text.trim(), at: new Date(), outbound: true, state: "sending" });
  }
  catch (e) {
    if (e.code !== 11000)
      throw e;
    return Message.findOne({ thread: t._id, key }).select("state").lean();
  }
  let remoteId;
  try {
    if (t.channel === "telegram") {
      const res = await provider.telegram("sendMessage", { business_connection_id: a.connectionId, chat_id: t.peer, text: item.text });
      remoteId = String(res.result.message_id);
    }
    else {
      const res = await provider.graph(a.externalId + "/messages", provider.unseal(a.secret), { messaging_product: "whatsapp", to: t.peer, type: "text", text: { body: item.text } });
      remoteId = res.messages?.[0]?.id;
    }
  }
  catch (e) {
    const state = e instanceof CrmError ? "failed" : "unconfirmed";
    await Message.updateOne({ _id: item._id }, { $set: { state } });
    return { state };
  }
  if (!remoteId) {
    await Message.updateOne({ _id: item._id }, { $set: { state: "unconfirmed" } });
    return { state: "unconfirmed" };
  }
  try {
    await Message.updateOne({ _id: item._id }, { $set: { state: "sent", remoteId } });
  }
  catch (e) {
    if (e.code !== 11000)
      throw e;
    await Message.updateOne({ _id: item._id }, { $set: { state: "sent", superseded: true } });
  }
  return { state: "sent" };
}
module.exports = { begin, whatsappFinish, telegramPair, history, reply, ready, whatsappEvent, telegramEvent };
