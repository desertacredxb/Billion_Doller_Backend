const mongoose = require("mongoose");
const Receipt = require("../models/OwnerEmailTest");
const sendEmail = require("../utils/sendEmail");
const plan = require("../data/emailSequence");
const WRITE = { w: "majority", j: true };
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const dateDubai = date => new Date(date.getTime() + 4 * 3600000).toISOString().slice(0, 10);

async function ensureStorage() {
  const connection = mongoose.connection;
  if (connection.readyState !== 1) throw Error("Delivery test storage unavailable");
  const name = Receipt.collection.collectionName;
  if (!await connection.db.listCollections({ name }, { nameOnly: true }).hasNext()) {
    try { await connection.db.createCollection(name); } catch (e) { if (e.code !== 48) throw e; }
  }
  for (const [fields, options] of Receipt.schema.indexes()) await Receipt.collection.createIndex(fields, options);
}

function testMessage(email, requestId) {
  const day = plan[0];
  return {
    to: email,
    subject: `BDFX delivery test ${requestId}`,
    text: `BDFX OWNER DELIVERY TEST\nReference: ${requestId}\n\nThis is your requested welcome-email preview.\n\n${day.heading}\n\n${day.body}\n\n${day.action}: https://www.billiondollarfx.com${day.path}\n\nBillion Dollar FX\nSupport: support@billiondollarfx.com\nTrading involves risk. No guaranteed returns.\n\nInternal delivery test for the signed-in owner. Check your Inbox and Spam folders. This test does not subscribe you to a campaign.`,
    headers: { "X-BDFX-Delivery-Test": requestId },
    throwOnError: true,
  };
}

function createService({ receipts = Receipt, send = sendEmail, ensure = ensureStorage, now = () => new Date(), logger = console } = {}) {
  let storageReady;
  const ready = () => storageReady ||= Promise.resolve().then(ensure).catch(error => { storageReady = null; throw error; });
  function identity(owner) {
    if (!owner?.isAdmin || owner.adminRole !== "owner" || !/^[a-f\d]{24}$/i.test(owner.id || "")
        || typeof owner.email !== "string" || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(owner.email)) throw Error("Owner unavailable");
    return { id: owner.id, email: owner.email.trim().toLowerCase() };
  }
  const key = (owner, time) => `${owner.id}:${dateDubai(time)}`;
  function publicReceipt(receipt, current = now()) {
    if (!receipt) return null;
    return { requestId: receipt.requestId, recipient: receipt.recipient,
      status: receipt.status === "accepted" ? "accepted"
        : receipt.status === "unknown" || current - new Date(receipt.reservedAt) >= 120000 ? "unconfirmed" : "sending",
      reservedAt: receipt.reservedAt, acceptedAt: receipt.acceptedAt || null };
  }
  async function status(owner) {
    const account = identity(owner); await ready();
    const receipt = await receipts.findById(key(account, now())).lean();
    return { recipient: account.email, availableToday: !receipt, test: publicReceipt(receipt) };
  }
  async function sendTest(owner, requestId) {
    const account = identity(owner);
    if (typeof requestId !== "string" || !UUID.test(requestId)) throw Error("Invalid test reference");
    await ready();
    const current = now(), id = key(account, current);
    let receipt = await receipts.findById(id).lean();
    if (receipt) return { recipient: account.email, availableToday: false, test: publicReceipt(receipt) };
    // The primary key is one reservation per owner and Dubai day, across workers/restarts.
    // Persist before SMTP. An uncertain send is never automatically repeated.
    try {
      [receipt] = await receipts.create([{ _id: id, ownerId: account.id, recipient: account.email, requestId,
        status: "sending", reservedAt: current, expiresAt: new Date(current.getTime() + 90 * 86400000) }], { writeConcern: WRITE });
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existing = await receipts.findById(id).lean();
      if (!existing) throw Error("Delivery test reservation unavailable");
      return { recipient: account.email, availableToday: false, test: publicReceipt(existing) };
    }
    try {
      await send(testMessage(account.email, requestId));
      const acceptedAt = now();
      const saved = await receipts.updateOne({ _id: id, requestId, status: "sending" }, { $set: { status: "accepted", acceptedAt } }, { writeConcern: WRITE });
      if (saved.matchedCount !== 1) throw Error("Acceptance not persisted");
      receipt.status = "accepted"; receipt.acceptedAt = acceptedAt;
      logger.info?.("BDFX owner email test: mail server accepted");
    } catch {
      receipt.status = "unknown";
      try { await receipts.updateOne({ _id: id, requestId, status: "sending" }, { $set: { status: "unknown" } }, { writeConcern: WRITE }); } catch { /* Existing reservation still prevents another send. */ }
      logger.error?.("BDFX owner email test: delivery unconfirmed; no automatic resend");
    }
    return { recipient: account.email, availableToday: false, test: publicReceipt(receipt) };
  }
  return { status, sendTest };
}
module.exports = { ...createService(), createService, testMessage, UUID };
