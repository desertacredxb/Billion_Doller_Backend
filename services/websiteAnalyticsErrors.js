const FAILURE_MESSAGES = {
  GA4_CREDENTIALS_INVALID: "The saved Google reporting credential is invalid. Check the complete service-account JSON in the server settings.",
  GA4_API_DISABLED: "Enable Google Analytics Data API in the reporting service account's Google Cloud project, then refresh this report.",
  GA4_ACCESS_DENIED: "The reporting service account needs Viewer access to the Billion Dollar FX Analytics property.",
  GA4_AUTH_FAILED: "Google could not authenticate the reporting service account. Check that its saved key is active and belongs to that account.",
  GA4_TIMEOUT: "Google reporting took too long. Please refresh shortly.",
  GA4_QUOTA: "Google reporting is temporarily rate limited. Please retry shortly.",
  GA4_REQUEST_INVALID: "Google could not accept this report request. Please contact support.",
  GA4_RESPONSE_INVALID: "Google returned an unexpected report format. Please contact support.",
  GA4_UNAVAILABLE: "Google reporting is unavailable. Please retry shortly.",
};
function reportingFailure(error) {
  const status = Number(error?.code || error?.response?.status);
  // Inspect provider signals locally; never return or log raw errors, credentials,
  // response bodies, URLs, request headers or stack traces.
  const reason = error?.reason;
  const message = typeof error?.message === "string" ? error.message : "";
  let code = "GA4_UNAVAILABLE";
  if (error?.code === "GA4_CREDENTIALS_INVALID" || message === "Reporting connection invalid") code = "GA4_CREDENTIALS_INVALID";
  else if (["SERVICE_DISABLED", "API_DISABLED"].includes(reason) || /SERVICE_DISABLED|has not been used in project.*before|Analytics Data API.*disabled/i.test(message)) code = "GA4_API_DISABLED";
  else if ([16, 401].includes(status) || /invalid_grant|invalid jwt|unauthenticated|invalid signature|DECODER routines|PEM routines/i.test(message)) code = "GA4_AUTH_FAILED";
  else if ([7, 403].includes(status)) code = "GA4_ACCESS_DENIED";
  else if ([4, 408, 504].includes(status) || ["ETIMEDOUT", "ECONNABORTED"].includes(error?.code)) code = "GA4_TIMEOUT";
  else if ([8, 429].includes(status)) code = "GA4_QUOTA";
  else if ([3, 400].includes(status)) code = "GA4_REQUEST_INVALID";
  else if (message === "Reporting response invalid") code = "GA4_RESPONSE_INVALID";
  return { code, message: FAILURE_MESSAGES[code] };
}
module.exports = { reportingFailure };
