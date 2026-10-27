require("dotenv").config({ quiet: true });
const { inspectWatiReadiness } = require("../services/watiOtpReadiness.service");

inspectWatiReadiness().then(result => {
  console.log(JSON.stringify(result));
  process.exitCode = result.readyForActivation ? 0 : 1;
}).catch(() => {
  console.log(JSON.stringify({ readyForActivation: false, canSend: false, blocker: "READINESS_CHECK_UNAVAILABLE" }));
  process.exitCode = 1;
});
