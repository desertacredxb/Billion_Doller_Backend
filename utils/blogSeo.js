const sanitizeHtml = require("sanitize-html");

function plainText(value = "") {
  return sanitizeHtml(String(value), { allowedTags: [], allowedAttributes: {} })
    .replace(/&(?:nbsp|amp|quot|apos|lt|gt);/g, entity => ({ "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" })[entity])
    .replace(/\s+/g, " ").trim();
}
function excerpt(value, length) {
  const text = plainText(value);
  if (text.length <= length) return text;
  return text.slice(0, length - 1).replace(/\s+\S*$/, "").trimEnd() + "…";
}
function completeSeo(post) {
  // Existing editorial overrides always win. Clearing a field regenerates it.
  return {
    ...post,
    metaTitle: post.metaTitle?.trim() || excerpt(post.title, 60),
    metaDescription: post.metaDescription?.trim() || excerpt(post.shortDescription || post.content, 160),
    coverAlt: post.coverAlt?.trim() || plainText(post.title),
    metaKeywords: post.metaKeywords?.length ? post.metaKeywords : [...new Set([...(post.tags || []), post.category].filter(Boolean))].slice(0, 8),
  };
}
function seoChecks(post) {
  return [
    { key: "title", passed: !!post.metaTitle && post.metaTitle.length <= 70, message: "Use a descriptive SEO title, preferably under 70 characters." },
    { key: "description", passed: !!post.metaDescription && post.metaDescription.length <= 170, message: "Add a concise, article-specific search description." },
    { key: "image", passed: !!post.coverImage && !!post.coverAlt, message: "Choose a cover image and descriptive alternative text." },
    { key: "headings", passed: /<h[23](?:\s|>)/i.test(post.content || ""), message: "Break the article into useful sections with headings." },
    { key: "links", passed: /href=["'](?:\/(?!\/)|https:\/\/www\.billiondollarfx\.com\/)/i.test(post.content || ""), message: "Link to a relevant BDFX guide or tool." },
  ];
}
module.exports = { plainText, excerpt, completeSeo, seoChecks };
