const express = require("express");
const router = express.Router();

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
router.post("/:email", createTicket);

// Get all tickets (admin view)
router.get("/admin", getAllTickets);

// Get all tickets of a user
router.get("/:email", getUserTickets);

// Get single ticket with messages
router.get("/one/:ticketId", getTicketWithMessages);

// Update ticket status (admin)
router.put("/:ticketId/status", updateTicketStatus);

// Delete a ticket (optional)
router.delete("/:ticketId", deleteTicket);

// --- Message Routes ---

// Get all messages of a ticket
router.get("/:ticketId/messages", getMessagesForTicket);

// Add a message to a ticket (from user or admin)
router.post("/:ticketId/messages", addMessageToTicket);

module.exports = router;
