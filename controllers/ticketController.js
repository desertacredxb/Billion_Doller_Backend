const Ticket = require("../models/Ticket");
const User = require("../models/User");
const Message = require("../models/Reply");

const CATEGORIES = ["Deposit/Withdrawal", "Account-verification", "MT5 Support", "IB Commission", "Bonous&Other Promotion", "Others"];
const text = value => typeof value === "string" ? value.trim() : "";
const validRequestId = value => value === undefined || (typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value));
function validateTicket(body = {}) {
  const value = { category: text(body?.category), subject: text(body?.subject), description: text(body?.description) };
  const errors = {};
  if (!CATEGORIES.includes(value.category)) errors.category = "Choose a support category.";
  if (value.subject.length < 3 || value.subject.length > 160) errors.subject = "Enter a subject of 3–160 characters.";
  if (value.description.length < 10 || value.description.length > 5000) errors.description = "Describe your issue in 10–5,000 characters.";
  if (!validRequestId(body?.requestId)) errors.requestId = "Refresh this page and try again.";
  if (body?.requestId !== undefined) value.requestId = body.requestId;
  return { value, errors };
}
function createController({ tickets = Ticket, users = User, messages = Message, notify = () => {} } = {}) {
  const fail = (res, error, message) => {
    console.error(message, error.name || "Error");
    return res.status(500).json({ message: "Unable to complete this request. Please try again shortly." });
  };
  async function createTicket(req, res) {
    let user, value;
    try {
      const result = validateTicket(req.body);
      if (Object.keys(result.errors).length) return res.status(400).json({ message: "Check the highlighted ticket details.", errors: result.errors });
      value = result.value;
      user = await users.findOne({ email: req.params.email });
      if (!user) return res.status(404).json({ message: "User not found." });
      if (value.requestId) {
        const existing = await tickets.findOne({ user: user._id, requestId: value.requestId });
        if (existing) return res.status(201).json(existing);
      }
      if (await tickets.countDocuments({ user: user._id, status: { $in: ["Open", "Pending"] } }) >= 2) {
        return res.status(409).json({ message: "You already have 2 active tickets. Reply to an existing ticket for updates." });
      }
      const ticket = await tickets.create({ user: user._id, ...value });
      res.status(201).json(ticket);
      Promise.resolve().then(notify).catch(() => console.error("Ticket notification delivery pending"));
    } catch (error) {
      if (error.code === 11000 && user && value?.requestId) {
        const existing = await tickets.findOne({ user: user._id, requestId: value.requestId });
        if (existing) return res.status(201).json(existing);
      }
      return fail(res, error, "Ticket creation failed");
    }
  }
  async function getAllTickets(_req, res) {
    try { res.json(await tickets.find().populate("user", "fullName email").sort({ createdAt: -1 })); }
    catch (error) { fail(res, error, "Ticket list failed"); }
  }
  async function getUserTickets(req, res) {
    try {
      const user = await users.findOne({ email: req.params.email });
      if (!user) return res.status(404).json({ message: "User not found." });
      res.json(await tickets.find({ user: user._id }).sort({ createdAt: -1 }));
    } catch (error) { fail(res, error, "Ticket list failed"); }
  }
  async function getTicketWithMessages(req, res) {
    try {
      const { ticketId } = req.params;
      const ticket = await tickets.findById(ticketId).populate("user", "fullName email");
      if (!ticket) return res.status(404).json({ message: "Ticket not found." });
      const isAdmin = req.principal.isAdmin;
      const readField = isAdmin ? "readByAdmin" : "readByUser";
      const senderType = isAdmin ? "User" : "Admin";
      await messages.updateMany({ ticket: ticketId, senderType, [readField]: false }, { $set: { [readField]: true } });
      const unread = await messages.countDocuments({ ticket: ticketId, senderType, [readField]: false });
      const field = isAdmin ? "unreadByAdmin" : "unreadByUser";
      await tickets.updateOne({ _id: ticketId }, { $set: { [field]: unread } });
      ticket[field] = unread;
      res.json({ ticket, messages: await messages.find({ ticket: ticketId }).sort({ createdAt: 1 }) });
    } catch (error) { fail(res, error, "Ticket retrieval failed"); }
  }
  async function updateTicketStatus(req, res) {
    try {
      const status = req.body?.status;
      if (!["Open", "Pending", "Closed"].includes(status)) return res.status(400).json({ message: "Choose Open, Pending or Closed." });
      if (!/^[a-f\d]{24}$/i.test(req.params.ticketId || "")) return res.status(404).json({ message: "Ticket not found." });
      const ticket = await tickets.findByIdAndUpdate(req.params.ticketId, { $set: { status } }, { new: true, runValidators: true });
      if (!ticket) return res.status(404).json({ message: "Ticket not found." });
      res.json(ticket);
    } catch (error) { fail(res, error, "Ticket update failed"); }
  }
  async function deleteTicket(req, res) {
    try {
      if (!/^[a-f\d]{24}$/i.test(req.params.ticketId || "")) return res.status(404).json({ message: "Ticket not found." });
      await messages.deleteMany({ ticket: req.params.ticketId });
      await tickets.findByIdAndDelete(req.params.ticketId);
      res.json({ message: "Ticket and messages deleted." });
    } catch (error) { fail(res, error, "Ticket removal failed"); }
  }
  async function addMessageToTicket(req, res) {
    const senderType = req.principal.isAdmin ? "Admin" : "User";
    const key = { ticket: req.params.ticketId, senderType, requestId: req.body?.requestId };
    try {
      const message = text(req.body?.message);
      if (!message || message.length > 5000 || !validRequestId(req.body?.requestId)) return res.status(400).json({ message: "Enter a message of 1–5,000 characters." });
      const attachments = req.body?.attachments;
      if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 5 || attachments.some(url => typeof url !== "string" || url.length > 2048 || !/^https:\/\//i.test(url)))) {
        return res.status(400).json({ message: "Use up to 5 secure attachment links." });
      }
      const ticket = await tickets.findById(req.params.ticketId);
      if (!ticket) return res.status(404).json({ message: "Ticket not found." });
      // Retrying a delivered message remains safe even if support has since closed the ticket.
      if (key.requestId) {
        const existing = await messages.findOne(key);
        if (existing) return res.status(201).json(existing);
      }
      if (ticket.status === "Closed") return res.status(409).json({ message: "This ticket is closed. Open a new ticket if you still need help." });
      const item = await messages.create({ ticket: ticket._id, message, senderType, ...(key.requestId ? { requestId: key.requestId } : {}), attachments, readByUser: senderType === "User", readByAdmin: senderType === "Admin" });
      await tickets.updateOne({ _id: ticket._id }, { $inc: { [senderType === "Admin" ? "unreadByUser" : "unreadByAdmin"]: 1 } });
      res.status(201).json(item);
    } catch (error) {
      if (error.code === 11000 && key.requestId) {
        const existing = await messages.findOne(key);
        if (existing) return res.status(201).json(existing);
      }
      fail(res, error, "Ticket reply failed");
    }
  }
  async function getMessagesForTicket(req, res) {
    try { res.json(await messages.find({ ticket: req.params.ticketId }).sort({ createdAt: 1 })); }
    catch (error) { fail(res, error, "Ticket messages failed"); }
  }
  return { createTicket, getAllTickets, getUserTickets, getTicketWithMessages, updateTicketStatus, deleteTicket, addMessageToTicket, getMessagesForTicket };
}
module.exports = { ...createController(), createController, validateTicket };
