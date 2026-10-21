// Client guidance from documented Veriff reason codes; never expose raw payloads.
const groups = [
  [[101, 504, 505, 516, 517, 518, 521, 522, 523], "An original physical ID was not captured. Use the actual document, not a screen or printed copy."],
  [[104, 541], "The submitted name did not match the ID. Correct your details to match the document."],
  [[103, 120, 509], "The face check could not match the document photo. The account holder must complete the selfie check."],
  [[206, 510, 602], "This document type is not supported. Use a supported government-issued photo ID."],
  [[207, 511], "The ID has expired. Use a valid document."],
  [[201, 202, 203, 204, 208, 209, 212, 213, 214, 215, 216, 546, 547, 551, 552, 553, 554, 555, 556, 557], "The required images were missing, unclear or incomplete. Retake clear images with the full ID and face visible."],
];
const retryable = new Set(groups.flatMap(([codes]) => codes));
function reasonCode(value) { const n = typeof value === "string" && /^\d{3}$/.test(value) ? Number(value) : value; return Number.isSafeInteger(n) && n >= 100 && n <= 999 ? n : null; }
function reasonMessage(value) {
  const code = reasonCode(value);
  if (code === 501) return "Veriff flagged this attempt for security review. Contact BDFX on WhatsApp to review the unsuccessful result.";
  return groups.find(([codes]) => codes.includes(code))?.[1] || (code ? "Additional identity checks were not passed. Contact BDFX on WhatsApp for a review of this result." : "The provider has not supplied a detailed reason. Contact BDFX on WhatsApp for assistance.");
}
module.exports = { reasonCode, reasonMessage, retryable };
