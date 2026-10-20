const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const access = require("../middleware/accessControl");
router.use(auth, access.principal);

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
router.post("/:email", access.emailOwner(), createTicket);

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
router.post("/:ticketId/messages", access.ticketOwner, addMessageToTicket);

module.exports = router;
