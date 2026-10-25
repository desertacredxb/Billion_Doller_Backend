const Session = require("../models/SupportChatSession");
const { LANGUAGES, TOPICS } = require("../controllers/supportChatController");
const DAY = 86400000;
function createReportService({ sessions = Session, now = () => new Date() } = {}) {
  return async function report(days = "7") {
    if (!["1", "7", "30"].includes(days)) throw new Error("Choose 1, 7 or 30 days");
    const at = now(), today = new Date(at.getTime() + 4 * 3600000).toISOString().slice(0, 10);
    const todayStart = new Date(`${today}T00:00:00+04:00`);
    const start = new Date(todayStart.getTime() - (Number(days) - 1) * DAY), bounds = { $gte: start, $lte: at };
    const filter = { consentVersion: "support-chat-2026-10", consentedAt: { $type: "date" }, expiresAt: { $gt: at } };
    const [started, active, contacts, groups] = await Promise.all([
      sessions.countDocuments({ ...filter, createdAt: bounds }),
      sessions.countDocuments({ ...filter, events: { $elemMatch: { at: bounds } } }),
      sessions.countDocuments({ ...filter, "contact.privacyAcceptedAt": bounds }),
      sessions.aggregate([{ $match: filter }, { $project: { events: 1 } }, { $unwind: "$events" },
        { $match: { "events.at": bounds } },
        { $group: { _id: { type: "$events.type", language: "$events.language", topic: "$events.topic", question: "$events.question" }, count: { $sum: 1 } } }]),
    ]);
    const eventsByLanguage = Object.fromEntries(LANGUAGES.map(key => [key, 0]));
    const topicSelections = Object.fromEntries(TOPICS.map(key => [key, 0]));
    const answersViewed = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [String(i), 0]));
    let supportHandoffs = 0;
    for (const group of groups) {
      if (!Number.isSafeInteger(group.count) || group.count < 0) throw new Error("Invalid report count");
      const id = group._id || {};
      if (LANGUAGES.includes(id.language)) eventsByLanguage[id.language] += group.count;
      if (id.type === "topic" && TOPICS.includes(id.topic)) topicSelections[id.topic] += group.count;
      if (id.type === "answer" && Number.isInteger(id.question) && id.question >= 0 && id.question < 14) answersViewed[id.question] += group.count;
      if (id.type === "team") supportHandoffs += group.count;
    }
    return { version: 1, source: "BDFX consented support sessions", generatedAt: at.toISOString(),
      period: { from: new Date(start.getTime() + 4 * 3600000).toISOString().slice(0, 10), to: today, timezone: "Asia/Dubai" },
      sessionsStarted: started, sessionsWithActivity: active, contactRequests: contacts, supportHandoffs,
      eventsByLanguage, topicSelections, answersViewed,
      coverage: "Saved sessions only; unsaved visitors are excluded. Sessions are not unique people. No contact details or free-text conversations are exported." };
  };
}
module.exports = { createReportService };
