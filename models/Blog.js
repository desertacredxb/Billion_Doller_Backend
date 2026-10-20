const mongoose = require("mongoose");

const blogSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 240 },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
  shortDescription: { type: String, required: true, maxlength: 1200 },
  content: { type: String, required: true },
  coverImage: { type: String, required: true },
  coverAlt: { type: String, default: "" },
  status: { type: String, enum: ["draft", "published", "archived"], default: "draft", index: true },
  author: { type: String, default: "Billion Dollar FX" },
  tags: [String], category: { type: String, required: true, index: true },
  faqs: [{ question: String, answer: String }],
  metaTitle: String, metaDescription: String, metaKeywords: [String],
  canonicalUrl: { type: String, default: "" },
  scheduledAt: { type: Date, default: null },
  featured: { type: Boolean, default: false },
  allowComments: { type: Boolean, default: false },
  readTimeMinutes: { type: Number, default: 0 },
  wordCount: { type: Number, default: 0 },
  publishedAt: { type: Date, default: null },
}, { timestamps: true });
blogSchema.index({ status: 1, publishedAt: -1, createdAt: -1 });
module.exports = mongoose.models.Blog || mongoose.model("Blog", blogSchema);
