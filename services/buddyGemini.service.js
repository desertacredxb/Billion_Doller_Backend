const axios = require("axios");
const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
function providerConfig(env) {
  const provider = env.BDFX_BUDDY_AI_PROVIDER || "openai";
  if (!["openai", "gemini"].includes(provider)) return null;
  const key = provider === "gemini" ? env.BDFX_BUDDY_GEMINI_API_KEY || env.GEMINI_API_KEY : env.OPENAI_API_KEY;
  const model = provider === "gemini" ? env.BDFX_BUDDY_GEMINI_MODEL || DEFAULT_GEMINI_MODEL : env.OPENAI_MODEL || "gpt-5";
  if (typeof key !== "string" || key.length < 20 || key.length > 4096) return null;
  if (provider === "gemini" && (typeof model !== "string" || model.length > 80 || !/^gemini-[a-z0-9.-]+$/.test(model))) return null;
  return { provider, key, model };
}
async function geminiAnswer(config, knowledge, question, post = axios.post) {
  const response = await post(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, {
    systemInstruction: { parts: [{ text: knowledge }] },
    contents: [{ role: "user", parts: [{ text: JSON.stringify(question) }] }],
    generationConfig: { maxOutputTokens: 1000, candidateCount: 1, responseMimeType: "text/plain", thinkingConfig: { thinkingLevel: "low", includeThoughts: false } },
  }, {
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.key },
    timeout: 8000, maxRedirects: 0, maxBodyLength: 16000, maxContentLength: 16000, responseType: "json",
  });
  const candidate = response.data?.candidates?.[0];
  if (response.data?.promptFeedback?.blockReason || candidate?.finishReason !== "STOP" || !Array.isArray(candidate.content?.parts)) return null;
  const visibleParts = candidate.content.parts.filter(part => part.thought !== true);
  if (!visibleParts.length || visibleParts.some(part => typeof part.text !== "string")) return null;
  return visibleParts.map(part => part.text).join("");
}
function geminiFailure(error) {
  const status = error?.response?.status;
  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT") return "gemini_timeout";
  if (status === 401 || status === 403) return "gemini_auth";
  if (status === 429) return "gemini_capacity";
  if (status === 404) return "gemini_model";
  return "gemini_request";
}
module.exports = { DEFAULT_GEMINI_MODEL, providerConfig, geminiAnswer, geminiFailure };
