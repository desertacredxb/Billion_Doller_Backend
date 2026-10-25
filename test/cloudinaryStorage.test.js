const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const express = require("express");
const multer = require("multer");
const { createCloudinaryStorage } = require("../utils/cloudinaryStorage");

function provider({ fail = false } = {}) {
  const uploads = [], removals = [];
  return { uploads, removals, uploader: {
    upload_stream(options, callback) {
      const chunks = []; uploads.push({ options, chunks });
      return new Writable({
        write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); },
        final(done) {
          done();
          queueMicrotask(() => fail ? callback(new Error("private provider key and response")) : callback(null, { public_id: `${options.folder}/${options.public_id}`, secure_url: "https://res.cloudinary.com/test/image/upload/document.png", bytes: Buffer.concat(chunks).length }));
        },
      });
    },
    destroy(id, options, callback) { removals.push({ id, options }); callback(null, { result: "ok" }); },
  } };
}

async function withServer(storage, limit, work) {
  const app = express();
  app.post("/upload", multer({ storage, limits: { fileSize: limit } }).single("document"), (req, res) => res.json({ filename: req.file.filename, path: req.file.path, size: req.file.size }));
  app.use((error, _req, res, _next) => res.status(400).json({ code: error.code || "UPLOAD_FAILED", message: error.message }));
  const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve));
  try { await work(`http://127.0.0.1:${server.address().port}/upload`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
const form = text => { const data = new FormData(); data.append("document", new Blob([text], { type: "image/png" }), "identity.png"); return data; };

test("streaming document storage preserves Multer metadata and fixed Cloudinary restrictions", async () => {
  const cloud = provider();
  await withServer(createCloudinaryStorage(cloud), 100, async url => {
    const response = await fetch(url, { method: "POST", body: form("synthetic-image") });
    assert.equal(response.status, 200); const file = await response.json();
    assert.match(file.filename, /^Billio-dollar-FX\/[a-f0-9-]{36}$/);
    assert.equal(file.path, "https://res.cloudinary.com/test/image/upload/document.png");
    assert.equal(file.size, 15);
    assert.deepEqual(cloud.uploads[0].options.allowed_formats, ["jpg", "jpeg", "png", "pdf"]);
    assert.equal(cloud.uploads[0].options.resource_type, "image");
    assert.equal(cloud.removals.length, 0);
  });
});
test("Multer file limits remove a stored partial document and return the size-limit error", async () => {
  const cloud = provider();
  // Keep the storage cap higher here to exercise Multer's cleanup of an object
  // that was stored before its size-limit rejection. Storage aborts are separate.
  await withServer(createCloudinaryStorage(cloud, { maxBytes: 100 }), 8, async url => {
    const response = await fetch(url, { method: "POST", body: form("too-long-image") });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, "LIMIT_FILE_SIZE");
    assert.ok(cloud.removals.length >= 1);
    assert.ok(cloud.removals.every(value => value.id.startsWith("Billio-dollar-FX/")));
    assert.ok(Buffer.concat(cloud.uploads[0].chunks).length < Buffer.byteLength("too-long-image"));
  });
});
test("the storage byte cap aborts an oversized stream before a cloud object is completed", async () => {
  const cloud = provider(); let destination;
  const upload = cloud.uploader.upload_stream;
  cloud.uploader.upload_stream = (...args) => (destination = upload(...args));
  const file = { stream: Readable.from([Buffer.from("too-long-image")]) };
  await new Promise(resolve => createCloudinaryStorage(cloud, { maxBytes: 8 })._handleFile({}, file, error => {
    assert.equal(error.code, "LIMIT_FILE_SIZE"); resolve();
  }));
  assert.equal(destination.destroyed, true);
  assert.equal(cloud.uploads.length, 1);
  assert.ok(Buffer.concat(cloud.uploads[0].chunks).length <= 8);
});
test("provider errors never expose upload details through the HTTP response", async () => {
  await withServer(createCloudinaryStorage(provider({ fail: true })), 100, async url => {
    const response = await fetch(url, { method: "POST", body: form("image") });
    assert.equal(response.status, 400);
    assert.equal((await response.text()).includes("private provider"), false);
  });
});
test("an interrupted input destroys the destination and completes the callback once", async () => {
  let output, count = 0;
  const cloud = { uploader: { upload_stream() { output = new Writable({ write(_chunk, _encoding, done) { done(); } }); return output; }, destroy(_id, _options, callback) { callback(null); } } };
  const file = { stream: new Readable({ read() { this.destroy(new Error("private interrupted request")); } }) };
  await new Promise(resolve => createCloudinaryStorage(cloud)._handleFile({}, file, error => { count++; assert.equal(error.message, "Document storage unavailable"); resolve(); }));
  assert.equal(output.destroyed, true); assert.equal(count, 1);
});
test("a late provider response cleans its object even after Multer has removed mutable file metadata", async () => {
  let respond, calls = 0;
  const removed = [];
  const cloud = { uploader: {
    upload_stream(_options, callback) { respond = callback; return new Writable({ write(_chunk, _encoding, done) { done(); } }); },
    destroy(id, _options, callback) { assert.equal(typeof id, "string"); removed.push(id); callback(null); },
  } };
  const file = { stream: new Readable({ read() { this.destroy(new Error("interrupted")); } }) };
  const storage = createCloudinaryStorage(cloud);
  await new Promise(resolve => storage._handleFile({}, file, error => { calls++; assert.ok(error); resolve(); }));
  const id = file.filename;
  await new Promise((resolve, reject) => storage._removeFile({}, file, error => error ? reject(error) : resolve()));
  assert.equal(file.filename, undefined);
  respond(null, { public_id: id, secure_url: "https://res.cloudinary.com/test/image/upload/document.png", bytes: 1 });
  assert.deepEqual(removed, [id, id]); assert.equal(calls, 1);
});
