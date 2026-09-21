const OpenAIService = require("../services/openai.service");

const handleChat = async (req, res, next) => {
  try {
    const { message, conversationId } = req.body;

    if (!message || typeof message !== "string" || message.trim() === "") {
      return res.status(400).json({
        success: false,
        error: "Message content is required.",
      });
    }

    // Generate conversation ID if not provided
    const targetConversationId =
      conversationId ||
      `conv_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    // Basic input sanitization
    const sanitizedMessage = message.replace(/<[^>]*>/g, "").trim();

    const reply = await OpenAIService.generateReply(
      targetConversationId,
      sanitizedMessage
    );

    return res.status(200).json({
      success: true,
      reply,
      conversationId: targetConversationId,
    });
  } catch (error) {
    next(error);
  }
};

const handleReset = async (req, res, next) => {
  try {
    const { conversationId } = req.body;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: "Conversation ID is required.",
      });
    }

    await OpenAIService.clearHistory(conversationId);

    return res.status(200).json({
      success: true,
      message: "Conversation history cleared successfully.",
    });
  } catch (error) {
    next(error);
  }
};

const handleHistory = async (req, res, next) => {
  try {
    const { conversationId } = req.query;

    if (!conversationId) {
      return res.status(400).json({
        success: false,
        error: "conversationId query parameter is required.",
      });
    }

    const history = await OpenAIService.getHistory(conversationId);

    return res.status(200).json({
      success: true,
      history,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  handleChat,
  handleReset,
  handleHistory,
};