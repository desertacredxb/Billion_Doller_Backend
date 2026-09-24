const crypto = require('node:crypto');
const axios = require('axios');

function providerReady(env = process.env) {
  return env.BDFX_KYC_AUTOMATION_ENABLED === 'true' && env.BDFX_KYC_RELEASE_APPROVED === 'true' && env.SUMSUB_MODE === 'production' &&
    Boolean(env.SUMSUB_LEVEL_NAME && env.SUMSUB_LEVEL_NAME !== 'bdfx-kyc-sandbox' &&
      env.SUMSUB_CLIENT_ID && env.SUMSUB_APP_TOKEN && env.SUMSUB_SECRET_KEY && env.SUMSUB_WEBHOOK_SECRET);
}

function createSumsubApi({ env = process.env, http = axios, now = Date.now } = {}) {
  async function sumsubRequest(method, path, data, headers = {}) {
    if (!providerReady(env)) throw Object.assign(new Error('Verification provider unavailable'), { code: 'PROVIDER_DISABLED' });
    if (!/^\/resources\//.test(path) || /[\r\n#]/.test(path)) throw new Error('Invalid provider API path');
    const verb = String(method).toUpperCase();
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(verb)) throw new Error('Invalid provider API method');
    const body = data === undefined ? undefined : Buffer.isBuffer(data) ? data :
      Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    const timestamp = String(Math.floor(now() / 1000));
    const digest = crypto.createHmac('sha256', env.SUMSUB_SECRET_KEY)
      .update(timestamp + verb + path);
    if (body) digest.update(body);
    const response = await http.request({
      method: verb, url: `https://api.sumsub.com${path}`, data: body,
      headers: { ...(headers['Content-Type'] || headers['content-type'] ? {} : { 'Content-Type': 'application/json' }), ...headers,
        'X-App-Token': env.SUMSUB_APP_TOKEN, 'X-App-Access-Ts': timestamp,
        'X-App-Access-Sig': digest.digest('hex') },
      timeout: 15000, maxRedirects: 0, proxy: false,
      maxBodyLength: 11 * 1024 * 1024, maxContentLength: 1024 * 1024,
    });
    return response.data;
  }
  const pathId = id => encodeURIComponent(String(id));
  return {
    sumsubRequest,
    fetchApplicant: id => sumsubRequest('GET', `/resources/applicants/${pathId(id)}/one`),
    fetchApplicantByExternalUserId: id => sumsubRequest('GET', `/resources/applicants/-;externalUserId=${pathId(id)}/one`),
    fetchReviewStatus: id => sumsubRequest('GET', `/resources/applicants/${pathId(id)}/status`),
    fetchIdentityStatus: id => sumsubRequest('GET', `/resources/applicants/${pathId(id)}/requiredIdDocsStatus`),
    fetchPoaStatus: id => sumsubRequest('GET', `/resources/checks/latest?applicantId=${pathId(id)}&type=POA`),
  };
}

module.exports = { ...createSumsubApi(), createSumsubApi, providerReady };
