const { appendFile } = require("node:fs/promises");
const TITLE = "BDFX production health alert";
const MARKER = "<!-- bdfx-production-health-v1 -->";
const ALERT_OWNER = "desertacredxb";
const TARGETS = [
  { name: "Backend and database", url: "https://billion-doller-backend.onrender.com/health", json: true },
  { name: "Public website", url: "https://www.billiondollarfx.com/", json: false },
];

async function checkTargets(fetcher = fetch) {
  return Promise.all(TARGETS.map(async target => {
    try {
      const response = await fetcher(target.url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(15000), headers: { "Cache-Control": "no-cache" } });
      if (response.status !== 200) return { name: target.name, ok: false, detail: `HTTP ${response.status}` };
      if (target.json) {
        const result = await response.json();
        if (result.status !== "ok" || result.database !== "connected") return { name: target.name, ok: false, detail: "Database readiness failed" };
      } else {
        const html = await response.text();
        if (!/Billion\s*Dollar\s*FX/i.test(html)) return { name: target.name, ok: false, detail: "Expected website content missing" };
      }
      return { name: target.name, ok: true, detail: "Healthy" };
    } catch { return { name: target.name, ok: false, detail: "Request failed or timed out" }; }
  }));
}

async function reportHealth({ results, github, checkedAt, runUrl }) {
  const failures = results.filter(result => !result.ok);
  const open = await github("GET", "/issues?state=open&creator=github-actions%5Bbot%5D&per_page=100");
  const existing = open.find(issue => !issue.pull_request && issue.title === TITLE && issue.body?.includes(MARKER));
  const body = `${MARKER}\nChecked: ${checkedAt}\n\n${results.map(result => `- ${result.name}: ${result.detail}`).join("\n")}\n\n[Workflow run](${runUrl})\n\nThis check reads public endpoints only. It does not create accounts, send OTPs or perform financial transactions.`;
  if (failures.length) {
    if (existing) await github("PATCH", `/issues/${existing.number}`, { body, assignees: [ALERT_OWNER] });
    else await github("POST", "/issues", { title: TITLE, body, assignees: [ALERT_OWNER] });
  } else if (existing) {
    await github("PATCH", `/issues/${existing.number}`, { state: "closed", state_reason: "completed", body: `${body}\n\nRecovered on this check.` });
  }
  return failures.length;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  const runId = process.env.GITHUB_RUN_ID;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !token || !/^\d+$/.test(runId || "")) throw new Error("Workflow context is required");
  const github = async (method, path, body) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("GitHub alert update failed");
    return response.json();
  };
  const results = await checkTargets();
  const count = await reportHealth({ results, github, checkedAt: new Date().toISOString(), runUrl: `https://github.com/${repo}/actions/runs/${runId}` });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, results.map(result => `- ${result.name}: ${result.detail}\n`).join(""));
  for (const result of results) console.log(`${result.name}: ${result.detail}`);
  if (count) process.exitCode = 1;
}
if (require.main === module) main().catch(() => { console.error("Production health workflow could not complete"); process.exitCode = 1; });
module.exports = { checkTargets, reportHealth, MARKER, TITLE };
