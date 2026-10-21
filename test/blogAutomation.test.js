const test = require("node:test");
const assert = require("node:assert/strict");
const { createService, ensureBlogStorage, WEEK } = require("../services/blogAutomation.service");
const { normalizePost, isLive } = require("../controllers/blogController");
const library = require("../data/educationalBlogSeries");
const clone = value => value == null ? value : structuredClone(value);

// A shared atomic in-memory store tests competing worker instances and restart
// recovery. It never connects to MongoDB or contacts a publishing/AI provider.
function matches(row, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") return expected.some(option => matches(row, option));
    const value = row[key];
    if (expected === null) return value == null;
    if (expected && typeof expected === "object" && !(expected instanceof Date)) return Object.entries(expected).every(([op, rhs]) => {
      if (op === "$lte") return value != null && new Date(value) <= new Date(rhs);
      if (op === "$gt") return value != null && new Date(value) > new Date(rhs);
      if (op === "$ne") return rhs === null ? value != null : value !== rhs;
      throw Error(`Unsupported fixture operator: ${op}`);
    });
    return value === expected;
  });
}
function model(key) {
  const rows = new Map();
  let sequence = 0;
  const updates = [];
  function apply(row, update, inserted) {
    if (inserted) Object.assign(row, clone(update.$setOnInsert || {}));
    Object.assign(row, clone(update.$set || {}));
    for (const [field, operation] of Object.entries(update.$push || {})) row[field] = [...(row[field] || []), ...clone(operation.$each)].slice(operation.$slice);
  }
  const query = values => ({ values, sort(fields) { this.values.sort((a, b) => { for (const [field, order] of Object.entries(fields)) { const av = a[field] instanceof Date ? a[field].getTime() : a[field] ?? 0; const bv = b[field] instanceof Date ? b[field].getTime() : b[field] ?? 0; if (av < bv) return -order; if (av > bv) return order; } return 0; }); return this; },
    limit(n) { this.values = this.values.slice(0, n); return this; }, select() { return this; }, async lean() { return clone(this.values); } });
  return { rows, updates,
    find(filter) { return query([...rows.values()].filter(row => matches(row, filter))); },
    findOne(filter) { const q = query([...rows.values()].filter(row => matches(row, filter))); q.lean = async function () { return clone(this.values[0] || null); }; q.then = (resolve, reject) => q.lean().then(resolve, reject); return q; },
    findById(id) { const value = rows.get(id) || null; return { lean: async () => clone(value), then: (resolve, reject) => Promise.resolve(clone(value)).then(resolve, reject) }; },
    async findOneAndUpdate(filter, update, options = {}) {
      updates.push({ filter: clone(filter), update: clone(update), options });
      let row = [...rows.values()].find(item => matches(item, filter));
      const inserted = !row;
      if (!row && !options.upsert) return null;
      if (!row) { row = { [key]: filter[key], _id: filter._id || `article-${++sequence}` }; rows.set(row[key], row); }
      apply(row, update, inserted);
      return clone(row);
    },
    async updateOne(filter, update) {
      updates.push({ filter: clone(filter), update: clone(update) });
      const row = [...rows.values()].find(item => matches(item, filter));
      if (row) apply(row, update, false);
      return { modifiedCount: row ? 1 : 0 };
    },
  };
}
function fixture() {
  const blogs = model("slug"); const states = model("_id");
  let clock = new Date("2026-10-21T02:00:00Z");
  const options = { blogs, states, now: () => new Date(clock), ensureStorage: async () => {}, logger: { info() {}, error() {} } };
  return { blogs, states, options, create: () => createService(options), advance(days) { clock = new Date(clock.getTime() + days * 86400000); } };
}

test("automatic SEO fills missing fields and preserves editorial overrides", () => {
  const post = normalizePost(library[0]);
  assert.ok(post.metaTitle.length <= 60); assert.ok(post.metaDescription.length <= 160);
  assert.ok(post.coverAlt); assert.ok(post.metaKeywords.length);
  const custom = normalizePost({ ...library[0], metaTitle: "My carefully edited title", metaDescription: "My own summary.", coverAlt: "My image description", metaKeywords: ["editor choice"] });
  assert.equal(custom.metaTitle, "My carefully edited title"); assert.equal(custom.metaDescription, "My own summary."); assert.equal(custom.coverAlt, "My image description");
  assert.deepEqual(custom.metaKeywords, ["editor choice"]);
  assert.throws(() => normalizePost({ ...library[0], autoPublish: "true" }));
  assert.equal(normalizePost({ ...library[0], status: "published", autoPublish: true }).autoPublish, false);
  assert.equal(normalizePost({ ...library[0], automationKey: "client-controlled", lastAutoPublishedAt: new Date() }).automationKey, undefined);
});

test("starter series contains distinct substantial articles with internal and primary-source links", () => {
  assert.equal(new Set(library.map(post => post.slug)).size, library.length);
  for (const article of library) {
    const post = normalizePost(article);
    assert.ok(post.wordCount >= 250, article.slug);
    assert.match(post.content, /href="\/(?:help-centre|platform|education|economic-calendar|currency-calculator)"/);
    assert.match(post.content, /https:\/\/www\.metatrader5\.com\/en\/terminal\/help\//);
    assert.doesNotMatch(post.content, /<script|onerror=|javascript:/i);
  }
});

test("two workers and repeated restarts publish one article, with all future drafts hidden", async () => {
  const f = fixture();
  await Promise.all([f.create().processPending(), f.create().processPending()]);
  await f.create().processPending();
  assert.equal(f.blogs.rows.size, library.length);
  const posts = [...f.blogs.rows.values()];
  assert.equal(posts.filter(post => isLive(post, f.options.now())).length, 1);
  assert.equal(posts.filter(post => post.status === "draft" && post.autoPublish).length, library.length - 1);
  assert.equal(f.states.rows.get("education-v1").nextPublishAt.getTime(), new Date("2026-10-21T02:00:00Z").getTime() + WEEK);
});

test("automation never overwrites edited content, dates, archives or colliding manual slugs", async () => {
  const f = fixture();
  f.blogs.rows.set(library[0].slug, { ...normalizePost(library[0]), status: "archived", content: "Preserve this original", updatedAt: new Date("2026-01-01") });
  await f.create().processPending();
  assert.equal(f.blogs.rows.get(library[0].slug).content, "Preserve this original");
  assert.equal(f.blogs.rows.get(library[0].slug).status, "archived");
  assert.equal(f.blogs.rows.get(library[0].slug).updatedAt.toISOString(), "2026-01-01T00:00:00.000Z");
  const second = f.blogs.rows.get(library[1].slug); second.content = "An editor's replacement content";
  await f.create().processPending();
  assert.equal(f.blogs.rows.get(library[1].slug).content, "An editor's replacement content");
  assert.ok(f.blogs.updates.filter(call => call.options?.upsert).every(call => call.options.timestamps === false));
});

test("a delayed worker publishes one due article and does not dump a backlog", async () => {
  const f = fixture(); const worker = f.create(); await worker.processPending();
  f.advance(60);
  await Promise.all([f.create().processPending(), f.create().processPending()]);
  await f.create().processPending();
  assert.equal([...f.blogs.rows.values()].filter(post => post.status === "published").length, 2);
  for (const post of [...f.blogs.rows.values()].filter(post => post.status === "published")) assert.equal(new Date(post.scheduledAt).getTime(), new Date(post.publishedAt).getTime());
  f.advance(7); await worker.processPending();
  assert.equal([...f.blogs.rows.values()].filter(post => post.status === "published").length, 3);
});

test("pausing prevents queued posts from publishing and resuming preserves the cadence", async () => {
  const f = fixture(); const worker = f.create(); await worker.processPending();
  await worker.setEnabled(false); f.advance(8); await f.create().processPending();
  assert.equal([...f.blogs.rows.values()].filter(post => post.status === "published").length, 1);
  await worker.setEnabled(true); await worker.processPending();
  assert.equal([...f.blogs.rows.values()].filter(post => post.status === "published").length, 2);
  assert.equal((await worker.status()).history.some(event => event.outcome === "paused"), true);
});

test("a lost checkpoint after publication retries the same reservation without a second post", async () => {
  const f = fixture(); const update = f.states.updateOne; let loseReply = true;
  f.states.updateOne = async (filter, change, options) => {
    if (loseReply && change.$set?.lastPublishedAt) { loseReply = false; throw Error("Database reply lost after article publication"); }
    return update(filter, change, options);
  };
  assert.equal((await f.create().processPending()).outcome, "retry");
  assert.equal(f.states.rows.get("education-v1").pendingSlug, library[0].slug);
  await f.create().processPending();
  assert.equal([...f.blogs.rows.values()].filter(post => post.status === "published").length, 1);
  assert.equal(f.states.rows.get("education-v1").pendingSlug, null);
  assert.equal((await f.create().status()).history.some(item => item.outcome === "retry"), true);
});

test("storage checks reject disconnected databases and do not treat partial indexes as full uniqueness", async () => {
  await assert.rejects(ensureBlogStorage({ readyState: 0 }));
  let created = 0;
  const collection = { listIndexes: () => ({ toArray: async () => [{ key: { slug: 1 }, unique: true, partialFilterExpression: { status: "published" } }] }),
    createIndex: async (key, options) => { created++; assert.deepEqual(key, { slug: 1 }); assert.equal(options.unique, true); } };
  await ensureBlogStorage({ readyState: 1, db: { listCollections: () => ({ hasNext: async () => true }), collection: () => collection } });
  assert.equal(created, 1);
});
