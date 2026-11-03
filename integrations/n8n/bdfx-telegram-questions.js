const GROUP_ID = '-1003981563127';
const BOT_USERNAME = 'bdfxaccountsreportbot';
function parseTelegramQuestion(update, now = new Date(), { enableAI = false, enableOpenAI = false } = {}) {
  const m = update?.message;
  if (!m || String(m.chat?.id) !== GROUP_ID || !['group', 'supergroup'].includes(m.chat.type)
    || !Number.isSafeInteger(m.from?.id) || m.from.id <= 0 || m.from.is_bot !== false || m.sender_chat || m.via_bot
    || !Number.isSafeInteger(m.message_id) || m.message_id <= 0 || !Number.isSafeInteger(update.update_id)
    || !Number.isFinite(m.date) || now.getTime() / 1000 - m.date > 300 || m.date - now.getTime() / 1000 > 30
    || typeof m.text !== 'string' || !m.text.trim() || m.text.length > 1000) return null;
  let text = m.text.normalize('NFKC').toLowerCase().trim();
  const command = text.match(/^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?:\s+(.*))?$/);
  if (command?.[2] && command[2] !== BOT_USERNAME) return null;
  const direct = text.includes('@' + BOT_USERNAME) || m.reply_to_message?.from?.username?.toLowerCase() === BOT_USERNAME;
  const asked = direct || /[?？]|\b(kitna|kitne|kiska|kiski|kya|kaise|kab|batao|bata|who|what|why|how|which|where)\b|कितन|किस|क्या|कैसे|कब/.test(text);
  text = text.replace('@' + BOT_USERNAME, '').trim();
  const commands = { start: 'help', help: 'help', pending: 'pending_withdrawals', payouts: 'pending_withdrawals', report: 'report', summary: 'report', deposits: 'deposits', deposit: 'deposits', withdrawals: 'withdrawals', clients: 'clients', registrations: 'clients', kyc: 'kyc', buddy: 'buddy', mt5: 'mt5', ib: 'ib', tickets: 'tickets', seo: 'seo' };
  let topic = command ? (commands[command[1]] || 'help') : null;
  let page = 1;
  if (command && topic === 'pending_withdrawals' && command[3]) {
    if (/^[1-9]\d{0,2}$/.test(command[3])) page = Number(command[3]); else topic = 'help';
  } else if (command?.[3]) topic = 'help';
  if (!command) {
    if (/\b(otp|password|token|bank|wallet|ifsc|upi|phone|mobile|email|approve|reject|transfer|delete|minimum|maximum|bonus|balance|positions?|pnl)\b/.test(text)
      || (/\b\d{4,12}\b/.test(text) && /client|account|mt5/.test(text))) topic = asked ? 'help' : null;
    else if (/withdraw|withdr|payout|निकासी|विड्र|विथड्र/.test(text)) topic = /today|aaj|आज|complete|success|total/.test(text) && !/pending|processing|kiska|kiski|whose|किस|पेंडिंग/.test(text) ? 'withdrawals' : 'pending_withdrawals';
    else if (/deposit|depost|जमा|डिपॉजिट/.test(text)) topic = 'deposits';
    else if (/kyc|verification|वेरिफ|केवाईसी/.test(text)) topic = 'kyc';
    else if (/registration|register|clients?|user|रजिस्ट्र|क्लाइंट/.test(text)) topic = 'clients';
    else if (/buddy|chatbot/.test(text)) topic = 'buddy';
    else if (/mt5|metatrader|live account/.test(text)) topic = 'mt5';
    else if (/\bib\b|broker|commission/.test(text)) topic = 'ib';
    else if (/ticket|support queue/.test(text)) topic = 'tickets';
    else if (/seo|blogs?|publishing|sitemap/.test(text)) topic = 'seo';
    else if (/report|summary|रिपोर्ट/.test(text)) topic = 'report';
    else if (asked || /^(help|hello|hi|start|मदद)[!?\s]*$/.test(text)) topic = 'help';
  }
  if ((enableAI || enableOpenAI) && !command && (topic || asked || /bdfx|billion dollar/.test(text))) topic = 'assistant';
  if (!topic) return null;
  return { chatId: GROUP_ID, senderId: m.from.id, replyMessageId: m.message_id, updateId: update.update_id, topic, page, runMode: 'question',
    ...(topic === 'assistant' ? { question: m.text.trim(), replyContext: m.reply_to_message?.from?.username?.toLowerCase() === BOT_USERNAME ? String(m.reply_to_message.text || '').slice(0, 1500) : '' } : {}) };
}
function verifyTelegramMember(meta, response) {
  const member = response?.result ?? response;
  if (response?.ok === false || !meta || meta.chatId !== GROUP_ID || member?.user?.id !== meta.senderId || member.user.is_bot !== false
    || !(['creator', 'administrator', 'member'].includes(member.status) || (member.status === 'restricted' && member.is_member === true))) return null;
  return { ...meta, memberVerified: true };
}
function formatTelegramAnswer(response, meta, now = new Date()) {
  const body = response?.body ?? response;
  const generated = new Date(body?.generatedAt);
  const sourceVerified = (!response?.statusCode || response.statusCode === 200) && body?.version === 1 && body.source === 'BDFX Telegram operations'
    && body.topic === meta.topic && body.page === meta.page && Number.isFinite(generated.getTime())
    && now - generated <= 120000 && generated - now <= 30000 && typeof body.reply === 'string' && body.reply.length > 0 && body.reply.length <= 3500;
  const summary = sourceVerified ? body.reply : meta.topic === 'assistant' && body?.code === 'OPERATIONS_AI_UNAVAILABLE'
    ? 'BDFX AI chat is unavailable right now. Existing BDFX reports can still be read using /report, /pending or /seo. This does not confirm a website or database outage.'
    : 'BDFX live reporting source is unavailable or unverified right now. No client or payment details can be confirmed. Please try again shortly.';
  return { ...meta, sourceVerified, provider: sourceVerified ? body.provider || 'direct' : null, summary, html: summary.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
}
module.exports = { GROUP_ID, BOT_USERNAME, parseTelegramQuestion, verifyTelegramMember, formatTelegramAnswer };
