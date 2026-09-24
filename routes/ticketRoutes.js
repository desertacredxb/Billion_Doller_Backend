const express = require("express");
const router = express.Router();
const auth = require("../middleware/authMiddleware");
const { loadPrincipal, requireAdmin, requireOwnerEmail } = require("../middleware/accessControl");

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
router.use(auth, loadPrincipal);
router.param("ticketId", (req, res, next, ticketId) => {
  if (!/^[a-fA-F0-9]{24}$/.test(ticketId)) {
    return res.status(400).json({ message: "Invalid ticket ID." });
  }
  next();
});

// Create a new ticket (user)
router.post("/:email", requireOwnerEmail("params", "email"), createTicket);

// Get all tickets (admin view)
router.get("/admin", requireAdmin, getAllTickets);

// Get all tickets of a user
router.get("/:email", requireOwnerEmail("params", "email"), getUserTickets);

// Get single ticket with messages
router.get("/one/:ticketId", getTicketWithMessages);

// Update ticket status (admin)
router.put("/:ticketId/status", requireAdmin, updateTicketStatus);

// Delete a ticket (optional)
router.delete("/:ticketId", requireAdmin, deleteTicket);

// --- Message Routes ---

// Get all messages of a ticket
router.get("/:ticketId/messages", getMessagesForTicket);

// Add a message to a ticket (from user or admin)
router.post("/:ticketId/messages", addMessageToTicket);

module.exports = router;
