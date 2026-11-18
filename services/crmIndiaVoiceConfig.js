function indiaVoiceConfigured(env = process.env) {
  return Boolean(env.BDFX_INDIAVOICE_API_USERNAME?.trim() && env.BDFX_INDIAVOICE_API_PASSWORD);
}

module.exports = { indiaVoiceConfigured };
