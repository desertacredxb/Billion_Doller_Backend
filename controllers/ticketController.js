const Ticket = require("../models/Ticket");
const User = require("../models/User");
const Message = require("../models/Reply");
const sendEmail = require("../utils/sendEmail");

// Ticket ownership is always resolved from the stored relation, never a
// caller-provided email, viewer role or sender type.
function canAccessTicket(req, res, ticket) {
  if (!req.principal) {
    res.status(401).json({ message: "Authentication required." });
    return false;
  }
  if (!ticket) {
    res.status(404).json({ message: "Ticket not found" });
    return false;
  }
  const ownerId = String(ticket.user?._id || ticket.user || "");
  if (!req.principal.isAdmin && ownerId !== req.principal.id) {
    res.status(403).json({ message: "Access denied." });
    return false;
  }
  return true;
}

// Create a new support ticket
exports.createTicket = async (req, res) => {
  try {
    const { email } = req.params;
    const { category, subject, description } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    // ✅ Count open + pending tickets for this user
    const activeTickets = await Ticket.countDocuments({
      user: user._id,
      status: { $in: ["Open", "Pending"] },
    });

    if (activeTickets >= 2) {
      return res
        .status(400)
        .json({ message: "You already have 2 active tickets." });
    }

    const ticket = await Ticket.create({
      user: user._id,
      category,
      subject,
      description,
    });

    await sendEmail({
      to: process.env.EMAIL_USER,
      subject: `🎫 New Ticket from ${user.name || email}`,
      text: `A new support ticket has been created.

User: ${user.name || "N/A"} (${email})
Category: ${category}
Subject: ${subject}
Description: ${description}`,
      html: `
        <h2>New Support Ticket</h2>
        <p><strong>User:</strong> ${user.name || "N/A"} (${email})</p>
        <p><strong>Category:</strong> ${category}</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <p><strong>Description:</strong> ${description}</p>
        <br/>
        <small>This is an automated notification.</small>
      `,
    });

    res.status(201).json(ticket);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error creating ticket", error: err.message });
  }
};

// Get all tickets (admin)
exports.getAllTickets = async (req, res) => {
  try {
    const tickets = await Ticket.find()
      .populate("user", "fullName email")
      .sort({ createdAt: -1 });
    res.status(200).json(tickets);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching tickets", error: err.message });
  }
};

// Get tickets by user email
exports.getUserTickets = async (req, res) => {
  try {
    const { email } = req.params;

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const tickets = await Ticket.find({ user: user._id }).sort({
      createdAt: -1,
    });
    res.status(200).json(tickets);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching user tickets", error: err.message });
  }
};

// Get a ticket with messages
// controller (replace getTicketWithMessages)
exports.getTicketWithMessages = async (req, res) => {
  try {
    const { ticketId } = req.params;

    const ticket = await Ticket.findById(ticketId).populate(
      "user",
      "fullName email"
    );

    if (!canAccessTicket(req, res, ticket)) return;
    const isAdminViewing = req.principal.isAdmin;

    if (isAdminViewing) {
      // Admin is viewing -> mark user-sent messages as readByAdmin
      await Message.updateMany(
        { ticket: ticketId, senderType: "User", readByAdmin: false },
        { $set: { readByAdmin: true } }
      );

      // Recompute unreadByAdmin counter and save
      const unreadByAdmin = await Message.countDocuments({
        ticket: ticketId,
        senderType: "User",
        readByAdmin: false,
      });
      ticket.unreadByAdmin = unreadByAdmin;
      await ticket.save();
    } else {
      // User is viewing -> mark admin-sent messages as readByUser
      await Message.updateMany(
        { ticket: ticketId, senderType: "Admin", readByUser: false },
        { $set: { readByUser: true } }
      );

      // Recompute unreadByUser counter and save
      const unreadByUser = await Message.countDocuments({
        ticket: ticketId,
        senderType: "Admin",
        readByUser: false,
      });
      ticket.unreadByUser = unreadByUser;
      await ticket.save();
    }

    const messages = await Message.find({ ticket: ticketId }).sort({
      createdAt: 1,
    });

    res.status(200).json({ ticket, messages });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error retrieving ticket", error: err.message });
  }
};

// Update ticket status
exports.updateTicketStatus = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { status } = req.body;

    if (!["Open", "Pending", "Closed"].includes(status)) {
      return res.status(400).json({ message: "Invalid ticket status." });
    }

    const updated = await Ticket.findByIdAndUpdate(
      ticketId,
      { status },
      { new: true, runValidators: true }
    );
    if (!updated) return res.status(404).json({ message: "Ticket not found" });

    res.status(200).json(updated);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error updating status", error: err.message });
  }
};

// Delete a ticket
exports.deleteTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;

    await Message.deleteMany({ ticket: ticketId });
    await Ticket.findByIdAndDelete(ticketId);

    res.status(200).json({ message: "Ticket and messages deleted" });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error deleting ticket", error: err.message });
  }
};

// Add a message to a ticket

exports.addMessageToTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { message, attachments } = req.body;

    const ticket = await Ticket.findById(ticketId);
    if (!canAccessTicket(req, res, ticket)) return;
    const senderType = req.principal.isAdmin ? "Admin" : "User";

    // New message with proper read flags
    const newMessageData = {
      ticket: ticketId,
      message,
      senderType,
      attachments,
      readByUser: senderType === "User" ? true : false, // User's own messages are "read" for them
      readByAdmin: senderType === "Admin" ? true : false, // Admin's own messages are "read" for them
    };

    const newMessage = await Message.create(newMessageData);

    // Update unread counters
    if (senderType === "Admin") {
      ticket.unreadByUser = (ticket.unreadByUser || 0) + 1;
    } else {
      ticket.unreadByAdmin = (ticket.unreadByAdmin || 0) + 1;
    }
    await ticket.save();

    res.status(201).json(newMessage);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ message: "Error adding message", error: err.message });
  }
};

// Get all messages for a ticket
exports.getMessagesForTicket = async (req, res) => {
  try {
    const { ticketId } = req.params;
    const ticket = await Ticket.findById(ticketId);
    if (!canAccessTicket(req, res, ticket)) return;

    const messages = await Message.find({ ticket: ticketId }).sort({
      createdAt: 1,
    });
    res.status(200).json(messages);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Error fetching messages", error: err.message });
  }
};
