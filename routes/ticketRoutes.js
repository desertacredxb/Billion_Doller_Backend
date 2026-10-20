const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
const { rateLimit } = require("express-rate-limit");
router.use(auth, access.principal);
const writes = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false, keyGenerator: req => req.principal.id, message: { message: "Too many support requests. Please wait a minute and try again." } });

const {
  createTicket,
  getAllTickets,
  getUserTickets,
  getTicketWithMessages,
  updateTicketStatus,
  deleteTicket,
  addMessageToTicket,
  getMessagesForTicket,
} = require("../controllers/ticketController");

// --- Ticket Routes ---

// Create a new ticket (user)
router.post("/:email", access.emailOwner(), writes, createTicket);

// Get all tickets (admin view)
router.get("/admin", access.admin, getAllTickets);

// Get all tickets of a user
router.get("/:email", access.emailOwner(), getUserTickets);

// Get single ticket with messages
router.get("/one/:ticketId", access.ticketOwner, getTicketWithMessages);

// Update ticket status (admin)
router.put("/:ticketId/status", access.admin, updateTicketStatus);

// Delete a ticket (optional)
router.delete("/:ticketId", access.admin, deleteTicket);

// --- Message Routes ---

// Get all messages of a ticket
router.get("/:ticketId/messages", access.ticketOwner, getMessagesForTicket);

// Add a message to a ticket (from user or admin)
router.post("/:ticketId/messages", access.ticketOwner, writes, addMessageToTicket);

module.exports = router;
