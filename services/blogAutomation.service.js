const { randomUUID } = require("node:crypto");
const mongoose = require("mongoose");
const Blog = require("../models/Blog");
const State = require("../models/BlogAutomation");
const library = require("../data/educationalBlogSeries");
const { normalizePost } = require("../controllers/blogController");
const ID = "education-v1";
const WEEK = 7 * 24 * 60 * 60 * 1000;
const WRITE = { w: "majority", j: true };

async function ensureBlogStorage(connection = mongoose.connection) {
  if (connection.readyState !== 1) throw new Error("Blog storage is not connected");
  const name = Blog.collection.collectionName;
  if (!await connection.db.listCollections({ name }, { nameOnly: true }).hasNext()) {
    try { await connection.db.createCollection(name); } catch (error) { if (error.code !== 48) throw error; }
  }
  const collection = connection.db.collection(name);
  const indexes = await collection.listIndexes().toArray();
  const unique = indexes.some(index => index.unique && !index.sparse && !index.partialFilterExpression && Object.keys(index.key).length === 1 && index.key.slug === 1);
  if (!unique) await collection.createIndex({ slug: 1 }, { name: "slug_1", unique: true });
}

function createService({ blogs = Blog, states = State, articles = library, now = () => new Date(), ensureStorage = ensureBlogStorage, enabled = () => process.env.AUTO_BLOGS_ENABLED !== "false", logger = console } = {}) {
  let running = false;
  let storage;
  let runtimeError = "";
  const ready = () => storage ||= ensureStorage().catch(error => { storage = null; throw error; });

  async function initialize(current) {
    try {
      return await states.findOneAndUpdate({ _id: ID }, { $setOnInsert: { enabled: true, startedAt: current, nextPublishAt: current } }, { upsert: true, new: true, writeConcern: WRITE });
    } catch (error) {
      if (error.code !== 11000) throw error;
      return states.findById(ID);
    }
  }

  async function processPending() {
    if (running || !enabled()) return { outcome: "paused" };
    running = true;
    const token = randomUUID();
    let locked = false;
    let outcome = "waiting";
    let publishedSlug = null;
    let failure = "";
    try {
      await ready();
      runtimeError = "";
      const current = now();
      await initialize(current);
      let state = await states.findOneAndUpdate({ _id: ID, enabled: true, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: current } }] },
        { $set: { leaseToken: token, leaseUntil: new Date(current.getTime() + 300000) } }, { new: true, writeConcern: WRITE });
      if (!state) return { outcome: "busy_or_paused" };
      locked = true;

      // Fixed slugs + a full unique index make retries/restarts idempotent.
      // Never update existing content, even if it has been edited or archived.
      for (const [position, article] of articles.entries()) {
        const post = normalizePost({ ...article, status: "draft", autoPublish: true, scheduledAt: new Date(new Date(state.startedAt).getTime() + position * WEEK) }, {}, current);
        if (post.wordCount < 250) throw new Error("Starter article is incomplete");
        try {
          await blogs.findOneAndUpdate({ slug: post.slug }, { $setOnInsert: { ...post, automationKey: `${ID}:${post.slug}`, createdAt: current, updatedAt: current } }, { upsert: true, new: true, runValidators: true, timestamps: false, writeConcern: WRITE });
        } catch (error) { if (error.code !== 11000) throw error; }
      }

      // A durable reservation is retried for the same article if the process
      // stops after publication but before updating the cadence checkpoint.
      if (!state.pendingSlug && new Date(state.nextPublishAt) <= current) {
        const candidate = await blogs.findOne({ status: "draft", autoPublish: true, $or: [{ scheduledAt: null }, { scheduledAt: { $lte: current } }] })
          .sort({ scheduledAt: 1, createdAt: 1, _id: 1 }).lean();
        if (!candidate) outcome = "empty";
        else {
          state = await states.findOneAndUpdate({ _id: ID, enabled: true, leaseToken: token, leaseUntil: { $gt: now() } }, { $set: { pendingSlug: candidate.slug } }, { new: true, writeConcern: WRITE });
          if (!state) return { outcome: "lease_lost" };
        }
      }

      if (state.pendingSlug) {
        const currentState = await states.findOne({ _id: ID, enabled: true, leaseToken: token, leaseUntil: { $gt: now() } });
        if (!currentState) return { outcome: "lease_lost" };
        const publishedAt = now();
        let post = await blogs.findOneAndUpdate({ slug: state.pendingSlug, status: "draft", autoPublish: true, $or: [{ scheduledAt: null }, { scheduledAt: { $lte: publishedAt } }] },
          { $set: { status: "published", autoPublish: false, publishedAt, scheduledAt: publishedAt, lastAutoPublishedAt: publishedAt } }, { new: true, runValidators: true, writeConcern: WRITE });
        if (!post) post = await blogs.findOne({ slug: state.pendingSlug }).lean();
        const completed = post?.lastAutoPublishedAt;
        if (completed) {
          publishedSlug = post.slug;
          await states.updateOne({ _id: ID, leaseToken: token, pendingSlug: post.slug }, { $set: { pendingSlug: null, lastPublishedAt: completed, nextPublishAt: new Date(new Date(completed).getTime() + WEEK) } }, { writeConcern: WRITE });
          outcome = "published";
        } else {
          // An editor may have archived, rescheduled or removed a queued post.
          await states.updateOne({ _id: ID, leaseToken: token }, { $set: { pendingSlug: null } }, { writeConcern: WRITE });
          outcome = "editor_changed";
        }
      }
      if (publishedSlug) logger.info(`Blog automation published: ${publishedSlug}`);
      return { outcome, publishedSlug };
    } catch (error) {
      failure = Number.isInteger(error.code) ? `storage_error_${error.code}` : "storage_or_publication_failed";
      runtimeError = failure;
      outcome = "retry";
      logger.error(`Blog automation could not complete (${failure}); the existing website remains available.`);
      return { outcome };
    } finally {
      if (locked) {
        const event = { at: now(), outcome, slug: publishedSlug || "", code: failure };
        const update = { $set: { lastRunAt: event.at, lastOutcome: outcome, lastError: failure, leaseToken: null, leaseUntil: null } };
        if (["published", "retry", "editor_changed"].includes(outcome)) update.$push = { history: { $each: [event], $slice: -20 } };
        try { await states.updateOne({ _id: ID, leaseToken: token }, update, { writeConcern: WRITE }); } catch { /* Reservation/lease remains recoverable. */ }
      }
      running = false;
    }
  }

  async function status() {
    const [state, queued, recent] = await Promise.all([
      states.findById(ID).lean(),
      blogs.find({ status: "draft", autoPublish: true }).sort({ scheduledAt: 1, createdAt: 1 }).limit(12).select("title slug scheduledAt").lean(),
      blogs.find({ lastAutoPublishedAt: { $ne: null } }).sort({ lastAutoPublishedAt: -1 }).limit(8).select("title slug status lastAutoPublishedAt").lean(),
    ]);
    return { enabled: enabled() && state?.enabled !== false, environmentDisabled: !enabled(), cadenceDays: 7, starterArticles: articles.length,
      nextPublishAt: state?.nextPublishAt || null, lastRunAt: state?.lastRunAt || null, lastOutcome: state?.lastOutcome || "waiting",
      lastError: runtimeError || state?.lastError || "", queued, recent, history: (state?.history || []).map(item => ({ at: item.at, outcome: item.outcome, slug: item.slug, code: item.code })) };
  }
  async function setEnabled(value) {
    if (typeof value !== "boolean") throw new TypeError("Choose whether automatic publishing is enabled.");
    const current = now();
    await states.findOneAndUpdate({ _id: ID }, { $setOnInsert: { startedAt: current, nextPublishAt: current }, $set: { enabled: value, lastOutcome: value ? "resumed" : "paused" },
      $push: { history: { $each: [{ at: current, outcome: value ? "resumed" : "paused", slug: "", code: "" }], $slice: -20 } } }, { upsert: true, new: true, writeConcern: WRITE });
    return status();
  }
  function start() {
    const tick = () => processPending().catch(() => logger.error("Blog automation worker failed."));
    tick(); const timer = setInterval(tick, 300000); timer.unref(); return timer;
  }
  return { processPending, status, setEnabled, start };
}
module.exports = { ...createService(), createService, ensureBlogStorage, WEEK };
