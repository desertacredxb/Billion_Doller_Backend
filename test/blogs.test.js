const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizePost, isLive, createController } = require("../controllers/blogController");
const clock = new Date("2026-10-20T12:00:00Z");
const valid = () => ({ title: "Understanding a trading account", shortDescription: "A practical account setup guide.", content: "<h2>Start here</h2><p>Verify your account before creating a trading account.</p>", coverImage: "https://res.cloudinary.com/example/image/upload/guide.jpg", category: "Getting started" });
const response = () => ({ code: 200, headers: {}, status(value) { this.code = value; return this; }, set(key, value) { this.headers[key] = value; return this; }, json(value) { this.data = value; return this; } });

test("blog publication excludes drafts and scheduled articles, preserving the original publication date on edits", () => {
  const draft = normalizePost(valid(), {}, clock);
  assert.equal(draft.slug, "understanding-a-trading-account");
  assert.equal(isLive(draft, clock), false);
  const future = normalizePost({ ...valid(), status: "published", scheduledAt: "2026-10-21T12:00:00Z" }, {}, clock);
  assert.equal(isLive(future, clock), false);
  assert.equal(isLive(future, new Date("2026-10-21T12:00:00Z")), true);
  const published = normalizePost({ ...valid(), status: "published" }, {}, clock);
  const edited = normalizePost({ title: "Updated guide" }, published, new Date("2026-10-22T12:00:00Z"));
  assert.equal(edited.publishedAt.toISOString(), clock.toISOString());
});

test("blog HTML keeps editorial content but removes scripts, inline handlers, unsafe links and schema overrides", () => {
  const data = normalizePost({ ...valid(), _id: "injected", publishedAt: "2000-01-01", content: '<h2>Guide</h2><script>alert(1)</script><a href="javascript:alert(1)">Link</a><img src="https://example.invalid/guide.png" onerror="alert(1)"><p style="background:url(file:///etc/passwd)">Text</p>' }, {}, clock);
  assert.ok(data.content.includes("<h2>Guide</h2>"));
  assert.ok(data.content.includes('src="https://example.invalid/guide.png"'));
  for (const unsafe of ["script", "javascript:", "onerror", "style=", "file:"]) assert.equal(data.content.includes(unsafe), false);
  assert.equal(data._id, undefined);
  assert.equal(data.publishedAt, null);
  for (const patch of [{ coverImage: "javascript:alert(1)" }, { scheduledAt: "bad-date" }, { tags: { $ne: null } }, { status: "anything" }, { title: { $ne: null } }]) assert.throws(() => normalizePost({ ...valid(), ...patch }, {}, clock));
});

test("public listing escapes search syntax without bypassing scheduled-post filtering", async () => {
  let filter;
  const blogs = { find(query) { filter = query; return { sort() { return this; }, skip() { return this; }, limit() { return this; }, async lean() { return []; } }; }, countDocuments: async () => 0 };
  const res = response();
  await createController({ blogs, now: () => clock }).list({ query: { status: "published", search: "(a+)+$" } }, res, error => { throw error; });
  assert.equal(filter.status, "published");
  assert.deepEqual(filter.$or[1], { publishedAt: { $lte: clock } });
  assert.equal(filter.$and[0].$or[0].title.$regex, "\\(a\\+\\)\\+\\$");
  assert.equal(res.data.success, true);
});

test("public article lookup hides drafts and future posts, while administrators can edit them", async () => {
  for (const post of [{ ...valid(), status: "draft" }, { ...valid(), status: "published", publishedAt: new Date("2026-10-21T12:00:00Z") }]) {
    const controller = createController({ blogs: { findById: () => ({ lean: async () => post }) }, now: () => clock });
    const res = response();
    await controller.get({ params: { id: "012345678901234567890123" } }, res, error => { throw error; });
    assert.equal(res.code, 404);
    const admin = response();
    await controller.get({ params: { id: "012345678901234567890123" }, principal: { isAdmin: true } }, admin, error => { throw error; });
    assert.equal(admin.code, 200);
    assert.equal(admin.headers["Cache-Control"], "no-store");
  }
});

test("blog administration and uploads reject anonymous requests before database or file processing", async () => {
  const express = require("express");
  const app = express(); app.use("/api/blogs", require("../routes/blogRoutes"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  try {
    for (const [method, path] of [["GET", ""], ["POST", ""], ["POST", "/upload"], ["PATCH", "/012345678901234567890123"], ["DELETE", "/012345678901234567890123"]]) {
      const result = await fetch(`http://127.0.0.1:${server.address().port}/api/blogs${path}`, { method });
      assert.equal(result.status, 401, `${method} ${path}`);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
