const DECISIONS = new Set(["approved", "declined", "resubmission_requested", "review", "expired", "abandoned"]);
const TERMINAL = new Set(["approved", "test_approved", "declined", "expired", "abandoned"]);

function isUae(value) {
  const normalized = typeof value === "string" ? value.toUpperCase().replace(/[^A-Z]/g, "") : "";
  return ["AE", "ARE", "UAE", "UNITEDARABEMIRATES"].includes(normalized);
}

function normalizePhone(value) {
  if (typeof value !== "string" || !/^(?:\+|00)?[\d\s().-]+$/.test(value.trim())) return null;
  let digits = value.replace(/\D/g, "");
  if (value.trim().startsWith("00")) digits = digits.slice(2);
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

function phonePattern(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return null;
  return new RegExp(`^\\s*(?:\\+|00)?${normalized.slice(1).split("").join("[\\s().-]*")}\\s*$`);
}

function normalizeDecision(payload, webhookType) {
  const fullAuto = payload?.eventType === "fullauto";
  if (payload?.status !== "success" || fullAuto !== (webhookType === "fullauto")) return null;
  const verification = fullAuto ? payload.data?.verification : payload.verification;
  const status = fullAuto ? verification?.decision : verification?.status;
  const time = fullAuto ? payload.time : verification?.decisionTime;
  const timestamp = Date.parse(time);
  const id = fullAuto ? payload.sessionId : verification?.id;
  const reference = fullAuto ? payload.vendorData : verification?.vendorData;
  if (!DECISIONS.has(status) || typeof id !== "string" || typeof reference !== "string" ||
      !id || !reference || !Number.isFinite(timestamp)) return null;
  if (!fullAuto && status === "approved" && verification.code !== 9001) return null;
  const unwrap = field => fullAuto ? field?.value : field;
  return {
    id, reference, status, timestamp,
    reasonCode: require("./veriffReasons").reasonCode(verification.reasonCode),
    documentCountry: unwrap(verification.document?.country),
    documentType: unwrap(verification.document?.type),
    nationality: unwrap(verification.person?.nationality),
  };
}

function decisionOutcome(decision, user, config, duplicatePhone) {
  if (isUae(user.nationality) || isUae(user.residenceCountry) ||
      isUae(decision.documentCountry) || isUae(decision.nationality)) {
    return { status: "declined", approved: false, message: "We don't accept UAE clients or UAE-issued identity documents." };
  }
  if (duplicatePhone) {
    return { status: "review", approved: false, message: "This mobile number is already registered. Please contact support." };
  }
  if (decision.status !== "approved") {
    const messages = {
      declined: "Your identity could not be verified. Please contact support.",
      resubmission_requested: "Please continue verification and resubmit the requested information.",
      review: "Your verification needs further review. Please contact support.",
      expired: "Your verification session expired. Please start again.",
      abandoned: "Your verification was not completed. Please start again.",
    };
    return { status: decision.status, approved: false, message: messages[decision.status] };
  }
  const documentType = typeof decision.documentType === "string" ? decision.documentType.toUpperCase() : "";
  if (!user.isVerified || !user.residenceCountry?.trim() || !normalizePhone(user.phone) ||
      typeof decision.documentCountry !== "string" || !/^[A-Z]{2}$/i.test(decision.documentCountry) ||
      !["PASSPORT", "ID_CARD"].includes(documentType)) {
    return { status: "review", approved: false, message: "Your verification needs further review. Please contact support." };
  }
  if (config.mode !== "live" || user.veriff?.mode !== "live") {
    return { status: "test_approved", approved: false, message: "Test verification completed. Live account approval is disabled in test mode." };
  }
  return { status: "approved", approved: true, message: "Your identity has been verified successfully." };
}

function isStaleDecision(decision, current) {
  if (current?.decisionAt && decision.timestamp <= new Date(current.decisionAt).getTime()) return true;
  // A delayed resubmission/review webhook cannot undo a conclusive decision.
  return TERMINAL.has(current?.status) && !TERMINAL.has(decision.status);
}

module.exports = { isUae, normalizePhone, phonePattern, normalizeDecision, decisionOutcome, isStaleDecision };
