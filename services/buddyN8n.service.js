const axios = require("axios");
const { randomUUID, createHash, timingSafeEqual } = require("node:crypto");
const { LANGUAGES, validQuestion, containsPrivateDetails, safeAnswer } = require("./buddyAiProtocol");
const ORIGIN = "https://n8n.srv2093676.hstgr.cloud";
const digest = value => createHash("sha256").update(value).digest();
const configuredToken = token => typeof token === "string" && token.length >= 32 && token.length <= 200;
function validWebhook(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && url.pathname === "/webhook/bdfx-buddy-v1" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
function reportAuthorized(value, expected) {
  return configuredToken(expected) && typeof value === "string" && value.length <= 200 && timingSafeEqual(digest(value), digest(expected));
}
function createBuddyService({ env = process.env, post = axios.post, worker = require("./buddyAiWorker.service").createWorker({ env }) } = {}) {
  function available() {
    return env.BDFX_BUDDY_N8N_ENABLED === "true" && validWebhook(env.BDFX_BUDDY_N8N_WEBHOOK_URL) &&
      (env.BDFX_BUDDY_N8N_TRANSPORT === "ticket" ? worker.configured() : configuredToken(env.BDFX_BUDDY_N8N_TOKEN));
  }
  return {
    available,
    async reply(body) {
      if (!available()) return { status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } };
      if (!validQuestion(body)) {
        return { status: 400, body: { code: "INVALID_ASSISTANT_REQUEST" } };
      }
      const message = body.message.trim();
      if (containsPrivateDetails(message)) return { status: 400, body: { code: "REMOVE_PRIVATE_DETAILS" } };
      try {
        const ticketMode = env.BDFX_BUDDY_N8N_TRANSPORT === "ticket";
        const payload = ticketMode ? { ticket: await worker.issue(body) } : {
          requestId: randomUUID(), language: body.language, message, contextQuestion: body.contextQuestion ?? null,
        };
        const response = await post(env.BDFX_BUDDY_N8N_WEBHOOK_URL, payload,
          { headers: ticketMode ? { "Content-Type": "application/json" } : { "X-BDFX-Buddy-Key": env.BDFX_BUDDY_N8N_TOKEN }, timeout: 10000,
          maxRedirects: 0, maxBodyLength: 6000, maxContentLength: 16000, responseType: "json" });
        const data = response.data;
        if (!data || typeof data.answer !== "string" || !data.answer.trim() || data.answer.length > 2400 || data.language !== body.language ||
          !safeAnswer(data.answer)) throw new Error("Invalid assistant response");
        return { status: 200, body: { answer: data.answer.trim(), language: body.language } };
      } catch { return { status: 503, body: { code: "ASSISTANT_UNAVAILABLE" } }; }
    },
  };
}
module.exports = { createBuddyService, reportAuthorized, containsPrivateDetails, LANGUAGES };
