const Blog = require("../models/Blog");
const sanitizeHtml = require("sanitize-html");

const liveFilter = (now = new Date()) => ({ status: "published", $or: [{ publishedAt: null }, { publishedAt: { $lte: now } }] });
const isLive = (blog, now = new Date()) => blog?.status === "published" && (!blog.publishedAt || new Date(blog.publishedAt) <= now);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fields = ["title", "slug", "shortDescription", "content", "coverImage", "coverAlt", "status", "author", "tags", "category", "faqs", "metaTitle", "metaDescription", "metaKeywords", "canonicalUrl", "scheduledAt", "featured", "allowComments"];
const safeUrl = value => typeof value === "string" && (value.startsWith("/") && !value.startsWith("//") || /^https:\/\//i.test(value));

function normalizePost(input, existing = {}, now = new Date()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Enter the article details.");
  const data = { ...existing };
  for (const key of fields) if (Object.hasOwn(input, key)) data[key] = input[key];
  for (const key of ["title", "shortDescription", "content", "category", "coverImage"]) {
    if (typeof data[key] !== "string" || !data[key].trim()) throw new Error(`Complete the ${key.replace(/([A-Z])/g, " $1").toLowerCase()} field.`);
    data[key] = data[key].trim();
  }
  if (data.title.length > 240 || data.shortDescription.length > 1200 || data.category.length > 100 || data.content.length > 200000) throw new Error("The article exceeds the supported field length.");
  data.slug = String(data.slug || data.title).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!data.slug || data.slug.length > 240) throw new Error("Enter a valid article slug up to 240 characters.");
  data.status ||= "draft";
  if (!["draft", "published", "archived"].includes(data.status)) throw new Error("Choose draft, published or archived.");
  if (!safeUrl(data.coverImage) || data.canonicalUrl && !safeUrl(data.canonicalUrl)) throw new Error("Use a secure image/canonical URL or a local path.");
  for (const key of ["coverAlt", "author", "metaTitle", "metaDescription", "canonicalUrl"]) {
    if (data[key] !== undefined && (typeof data[key] !== "string" || data[key].length > 2000)) throw new Error(`Enter valid ${key} text.`);
  }
  for (const key of ["tags", "metaKeywords"]) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].length > 30 || data[key].some(value => typeof value !== "string" || value.length > 100))) throw new Error("Use up to 30 text tags or keywords.");
    data[key] = (data[key] || []).map(value => value.trim()).filter(Boolean);
  }
  if (data.faqs !== undefined && (!Array.isArray(data.faqs) || data.faqs.length > 30 || data.faqs.some(faq => !faq || typeof faq.question !== "string" || typeof faq.answer !== "string" || faq.question.length > 1000 || faq.answer.length > 10000))) throw new Error("Enter valid FAQ questions and answers.");
  data.faqs = (data.faqs || []).map(faq => ({ question: faq.question.trim(), answer: faq.answer.trim() })).filter(faq => faq.question && faq.answer);
  for (const key of ["featured", "allowComments"]) if (data[key] !== undefined && typeof data[key] !== "boolean") throw new Error(`Choose a valid ${key} setting.`);
  const scheduledAt = data.scheduledAt ? new Date(data.scheduledAt) : null;
  if (scheduledAt && !Number.isFinite(scheduledAt.getTime())) throw new Error("Enter a valid publication date.");
  data.scheduledAt = scheduledAt;
  data.publishedAt = data.status === "published" ? scheduledAt || existing.publishedAt || now : existing.publishedAt || null;
  data.content = sanitizeHtml(data.content, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
    allowedAttributes: { a: ["href", "title"], img: ["src", "alt", "width", "height", "loading"], th: ["colspan", "rowspan"], td: ["colspan", "rowspan"] },
    allowedSchemes: ["https", "http", "mailto"], allowedSchemesByTag: { img: ["https"] }, allowProtocolRelative: false,
  });
  const text = sanitizeHtml(data.content, { allowedTags: [], allowedAttributes: {} }).trim();
  if (!text) throw new Error("Add article text before saving.");
  data.wordCount = text.split(/\s+/).length;
  data.readTimeMinutes = Math.max(1, Math.ceil(data.wordCount / 200));
  return Object.fromEntries([...fields, "publishedAt", "wordCount", "readTimeMinutes"].map(key => [key, data[key]]).filter(([, value]) => value !== undefined));
}

function createController({ blogs = Blog, now = () => new Date() } = {}) {
  const notFound = res => res.status(404).json({ success: false, error: "Article not found." });
  const fail = (error, res, next) => {
    if (error.code === 11000) return res.status(409).json({ success: false, error: "This article slug is already in use." });
    if (["ValidationError", "CastError"].includes(error.name)) return res.status(400).json({ success: false, error: "Check the article fields and try again." });
    next(error);
  };
  return {
    async list(req, res, next) {
      try {
        const published = req.query.status === "published";
        const query = published ? liveFilter(now()) : {};
        if (!published && req.query.status) {
          if (!["draft", "archived"].includes(req.query.status)) return res.status(400).json({ error: "Invalid article status." });
          query.status = req.query.status;
        }
        if (typeof req.query.category === "string" && req.query.category.length <= 100) query.category = req.query.category;
        if (typeof req.query.search === "string" && req.query.search.trim()) {
          const search = escapeRegex(req.query.search.trim().slice(0, 120));
          query.$and = [{ $or: [{ title: { $regex: search, $options: "i" } }, { shortDescription: { $regex: search, $options: "i" } }] }];
        }
        const page = Math.max(1, Math.min(100000, Number.parseInt(req.query.page, 10) || 1));
        const limit = Math.max(1, Math.min(200, Number.parseInt(req.query.limit, 10) || 100));
        const [data, total] = await Promise.all([blogs.find(query).sort({ publishedAt: -1, createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), blogs.countDocuments(query)]);
        res.set("Cache-Control", published ? "public, max-age=0, s-maxage=60" : "no-store");
        res.json({ success: true, count: data.length, total, page, pages: Math.ceil(total / limit), data });
      } catch (error) { fail(error, res, next); }
    },
    async get(req, res, next) {
      try {
        if (!/^[a-f\d]{24}$/i.test(req.params.id || "")) return notFound(res);
        const blog = await blogs.findById(req.params.id).lean();
        if (!blog || !req.principal?.isAdmin && !isLive(blog, now())) return notFound(res);
        res.set("Cache-Control", req.principal?.isAdmin ? "no-store" : "public, max-age=0, s-maxage=60");
        res.json({ success: true, data: blog });
      } catch (error) { fail(error, res, next); }
    },
    async slug(req, res, next) {
      try {
        if (!/^[a-z0-9-]{1,240}$/.test(req.params.slug || "")) return notFound(res);
        const blog = await blogs.findOne({ slug: req.params.slug, ...liveFilter(now()) }).lean();
        if (!blog) return notFound(res);
        res.set("Cache-Control", "public, max-age=0, s-maxage=60");
        res.json({ success: true, data: blog });
      } catch (error) { fail(error, res, next); }
    },
    async create(req, res, next) {
      try {
        let body;
        try { body = normalizePost(req.body, {}, now()); } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
        const data = await blogs.create(body);
        res.status(201).json({ success: true, data });
      } catch (error) { fail(error, res, next); }
    },
    async update(req, res, next) {
      try {
        if (!/^[a-f\d]{24}$/i.test(req.params.id || "")) return notFound(res);
        const existing = await blogs.findById(req.params.id).lean();
        if (!existing) return notFound(res);
        let body;
        try { body = normalizePost(req.body, existing, now()); } catch (error) { return res.status(400).json({ success: false, error: error.message }); }
        const data = await blogs.findByIdAndUpdate(req.params.id, { $set: body }, { new: true, runValidators: true });
        res.json({ success: true, data });
      } catch (error) { fail(error, res, next); }
    },
    async remove(req, res, next) {
      try {
        if (!/^[a-f\d]{24}$/i.test(req.params.id || "")) return notFound(res);
        // Keep the content recoverable in the administrator's archived list.
        const data = await blogs.findByIdAndUpdate(req.params.id, { $set: { status: "archived" } }, { new: true });
        if (!data) return notFound(res);
        res.json({ success: true, message: "Article archived. It can be restored from the archived list." });
      } catch (error) { fail(error, res, next); }
    },
  };
}
module.exports = { createController, normalizePost, liveFilter, isLive };
