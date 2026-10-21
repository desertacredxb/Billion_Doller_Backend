const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path").posix;

test("the staged release contains every relative module reachable from the server entry point", t => {
  const root = require("node:path").resolve(__dirname, "..");
  let files;
  try { files = new Set(execFileSync("git", ["ls-files", "-z", "--cached"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean)); }
  catch { t.skip("Release packaging check requires a Git checkout."); return; }
  const visited = new Set(), missing = [];
  function visit(file) {
    if (visited.has(file) || !/\.(?:c?js)$/.test(file)) return;
    visited.add(file);
    const source = execFileSync("git", ["show", `:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 }).replace(/^\s*\/\/[^\n]*/gm, "");
    for (const match of source.matchAll(/\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) {
      const base = path.normalize(path.join(path.dirname(file), match[2]));
      const resolved = [base, `${base}.js`, `${base}.cjs`, `${base}.json`, `${base}/index.js`].find(candidate => files.has(candidate));
      if (!resolved) missing.push(`${file} requires ${match[2]}`); else visit(resolved);
    }
  }
  visit("index.js");
  assert.deepEqual(missing, [], "A local file used by the server is missing from the staged Git release.");
});
