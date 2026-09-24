const axios = require('axios');
const { normalizePhone } = require('../utils/phone');
const BDFX_SENDER = '441157911131';

const templateFor = (status) => ({
  pending: process.env.BDFX_WATI_KYC_PENDING_TEMPLATE,
  approved: process.env.BDFX_WATI_KYC_APPROVED_TEMPLATE,
  rejected: process.env.BDFX_WATI_KYC_REJECTED_TEMPLATE,
  resubmission: process.env.BDFX_WATI_KYC_RESUBMISSION_TEMPLATE,
})[status];

async function resolveBdfxSender() {
  const configured = String(process.env.BDFX_WATI_CHANNEL_NUMBER || '').trim();
  if (!configured) return BDFX_SENDER;
  const sender = normalizePhone(configured.startsWith('+') ? configured : `+${configured}`);
  return sender?.slice(1) === BDFX_SENDER ? BDFX_SENDER : null;
}

async function sendKycWhatsApp(phone, status, reason = '') {
  const template = templateFor(status);
  const number = normalizePhone(phone);
  if (!number || !template || !process.env.BDFX_WATI_BASE_URL || !process.env.BDFX_WATI_API_TOKEN) return false;
  let baseUrl;
  try {
    baseUrl = new URL(process.env.BDFX_WATI_BASE_URL);
    if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) return false;
  } catch { return false; }
  const sender = await resolveBdfxSender();
  if (!sender) return false;
  const url = `${baseUrl.href.replace(/\/$/, '')}/api/v1/sendTemplateMessage`;
  const response = await axios.post(url, {
    template_name: template,
    broadcast_name: `BDFX KYC ${status}`,
    channel_number: sender,
    parameters: ['rejected', 'resubmission'].includes(status) ? [{ name: process.env.BDFX_WATI_KYC_REASON_PARAMETER || '1', value: reason }] : [],
  }, {
    params: { whatsappNumber: number.slice(1) },
    headers: { Authorization: `Bearer ${process.env.BDFX_WATI_API_TOKEN}` },
    timeout: 10000,
  });
  if (response.status !== 200 || response.data?.result !== true) throw new Error('WATI rejected KYC template');
  return true;
}

module.exports = { sendKycWhatsApp };
