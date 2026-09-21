export const errorHandler = () => {
  console.error("AI Support Engine Error:", err);

  // Catching standard OpenAI API constraints dynamically
  if (err.status === 429) {
    return res
      .status(429)
      .json({
        success: false,
        error: "Rate limit hit. Please slow down requests.",
      });
  }
  if (err.status === 401) {
    return res
      .status(500)
      .json({
        success: false,
        error: "Authentication processing issue. Contact administrators.",
      });
  }

  res.status(err.status || 500).json({
    success: false,
    error: err.message || "Internal Server Exception encountered.",
  });
};
