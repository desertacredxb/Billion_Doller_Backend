const baseline = {
  "revision": "0c8a8c1824eb641b684f4aad8e25a4813646ae6d",
  "files": {
    "controllers/manualKycController.js": "35b39850d2244e6c0f47016a5e48cb979ddf98594656bc2c95500debb1977eaf",
    "controllers/veriffController.js": "071f969fe478970daf7d7074eeed8c250d755d6e7fd9cbc8cfc16633746a51aa",
    "models/KycReview.js": "c009527085ee86baa67ae28d502a12525c38bc72999d9d134fea724bd7c1d3c4",
    "models/schemas/veriff.schema.js": "7172f79d184946d5e2fcdc621d131b4cd382eda278438528e3a954a1fcd9b60b",
    "routes/veriffRoutes.js": "bf1e7eb00fdfeaf38bc3997b69106717ae8634f0bad68b4b21d67c4c0ac2e82c",
    "services/ibAutoApproval.service.js": "8769c0558c56bd3a8cb86f929d6bb890f081fc5c0a74cfa0bd0b4424a92610f2",
    "services/veriff.service.js": "28b0743d8f8c3d0fb2126f61c1647674e802fd3af2d3eb047f04a78dff239436",
    "services/veriffReadiness.service.js": "aad01b0526eea355cd6681a11ea8c3db9aad18be59ec03670036473c634c7e8d",
    "utils/veriffPolicy.js": "a39f710535108cbda9857e2d643022dcf7a98f078ab1006dad9d87480ce460b1",
    "utils/veriffReasons.js": "67d4815f239c768bbf5ff3acc0a1848f10b0fdd048d2ebe47d6086cc5d7177fc"
  },
  "sections": [
    {
      "path": "models/User.js",
      "start": "    kycProvider:",
      "end": "    address:",
      "hash": "8088e0a37148dbdc39bff0b577f3450b4d2cd8d7cd0fa45cc245cc2505ec7ff9"
    },
    {
      "path": "models/User.js",
      "start": "    hasSubmittedDocuments:",
      "end": "    createdAt:",
      "hash": "835f8147ea604e7ae2e3d9ab63af238ca5e17961ada5bb13a61b320681b8879e"
    }
  ],
  "lines": [
    {
      "path": "index.js",
      "line": "const veriffRoutes = require(\"./routes/veriffRoutes\");"
    },
    {
      "path": "index.js",
      "line": "  await checkOnStartup();"
    },
    {
      "path": "index.js",
      "line": "  app.use(\"/api/veriff\", veriffRoutes);"
    },
    {
      "path": "index.js",
      "line": "  require(\"./controllers/veriffController\").startApprovalReconciliation();"
    },
    {
      "path": "routes/authRoutes.js",
      "line": "router.post(\"/manual-kyc/:email\", access.owner, require(\"../controllers/manualKycController\").review);"
    },
    {
      "path": "middleware/accessControl.js",
      "line": "  const owner = (req, res, next) => req.principal?.isAdmin && req.principal.adminRole === \"owner\" ? next() : deny(res);"
    },
    {
      "path": "controllers/registrationController.js",
      "line": "        residenceCountry: kyc ? body.residenceCountry.trim() : undefined, kycProvider: kyc ? \"veriff\" : \"manual\","
    }
  ]
};

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");

const changed = new Set();
const digest = value => createHash("sha256").update(value).digest("hex");

function read(path) {
  try {
    return readFileSync(path);
  } catch {
    changed.add(path);
    return null;
  }
}

for (const [path, expected] of Object.entries(baseline.files)) {
  const content = read(path);
  if (content && digest(content) !== expected) changed.add(path);
}
for (const { path, start, end, hash } of baseline.sections) {
  const content = read(path)?.toString("utf8");
  if (content === undefined) continue;
  const from = content.indexOf(start);
  const to = content.indexOf(end, from + start.length);
  if (from < 0 || to <= from || content.indexOf(start, from + start.length) !== -1 ||
      digest(content.slice(from, to)) !== hash) changed.add(path);
}
for (const { path, line } of baseline.lines) {
  const content = read(path)?.toString("utf8");
  if (content !== undefined && content.split("\n").filter(value => value === line).length !== 1) changed.add(path);
}

if (changed.size) {
  console.error(`BDFX KYC is locked to ${baseline.revision}. Owner authorization is required to unlock:`);
  for (const path of [...changed].sort()) console.error(`  ${path}`);
  process.exitCode = 1;
} else {
  console.log(`BDFX KYC lock verified against ${baseline.revision}.`);
}
