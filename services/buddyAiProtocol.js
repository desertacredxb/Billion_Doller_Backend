const LANGUAGES = ["en", "hi", "bn", "th", "vi", "id"];
function containsPrivateDetails(value) {
  return /[^\s@]+@[^\s@]+\.[^\s@]+|(?:\d[\s()+-]?){6,}|\b0x[a-f\d]{20,}\b|\b(?:sk-|ghp_)[a-z\d_-]{12,}/i.test(value);
}
function validQuestion(body) {
  return !!body && typeof body === "object" && !Array.isArray(body) &&
    !Object.keys(body).some(key => !["language", "message", "consent", "contextQuestion"].includes(key)) &&
    body.consent === true && LANGUAGES.includes(body.language) && typeof body.message === "string" &&
    !!body.message.trim() && body.message.length <= 1000 &&
    (body.contextQuestion == null || (Number.isInteger(body.contextQuestion) && body.contextQuestion >= 0 && body.contextQuestion <= 13));
}
function safeAnswer(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2400 || /<\/?[a-z][^>]*>/i.test(value)) return false;
  return (value.match(/https?:\/\/[^\s<>()[\]]+/gi) || []).every(link => {
    try {
      const url = new URL(link.replace(/[.,;!]+$/, ""));
      return url.origin === "https://www.billiondollarfx.com" && !url.username && !url.password && !url.search;
    } catch { return false; }
  });
}
module.exports = { LANGUAGES, containsPrivateDetails, validQuestion, safeAnswer };
