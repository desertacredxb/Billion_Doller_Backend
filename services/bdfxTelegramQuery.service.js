const Withdrawal = require('../models/withdrawal');
const { createDailyReportService } = require('./bdfxDailyReport.service');
const { formatBdfxDailyReport } = require('../integrations/n8n/bdfx-report-format');

const TOPICS = ['help', 'pending_withdrawals', 'report', 'deposits', 'withdrawals', 'clients', 'kyc', 'buddy', 'mt5', 'ib', 'tickets', 'seo'];
const PAGE_SIZE = 10;
const clean = (value, size = 60) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, size) : '';
const dubaiTime = value => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(value);
const help = 'BDFX REPORTS • HELP\n\nThese are the connected reporting details I can currently show.\nAsk: payout pending kiska hai?\n/pending — pending/processing withdrawal details\n/pending 2 — next page\n/report — full daily report\n/deposits — today’s deposit counts\n/withdrawals — today’s withdrawal counts\n/clients — registrations and KYC counts\n/kyc — current KYC queue counts\n/mt5 — new live accounts today\n/ib — pending IB applications count\n/tickets — open/pending support ticket count\n/buddy — saved Buddy activity\n\nFor an unsupported question, use a command above; unavailable details are not guessed. Questions work in this BDFX Reports group, or as a reply to the bot. This bot reads reports; it cannot approve or execute payments. Bank details, wallet addresses, contact details and passwords are not shared.';

function createTelegramQueryService({ withdrawals = Withdrawal, dailyReport = createDailyReportService(), seoStatus = () => require('./blogAutomation.service').status(), now = () => new Date() } = {}) {
  return async function telegramQuery(topic, page = 1) {
    if (!TOPICS.includes(topic) || !Number.isSafeInteger(page) || page < 1 || page > 999 || (topic !== 'pending_withdrawals' && page !== 1)) throw new Error('INVALID_BUSINESS_QUERY');
    const at = now();
    let reply;
    if (topic === 'help') reply = help.replace('/buddy — saved Buddy activity', '/buddy — saved Buddy activity\n/seo — automatic SEO publishing status');
    else if (topic === 'seo') {
      const status = await seoStatus();
      if (typeof status?.enabled !== 'boolean' || !Array.isArray(status.queued) || !Array.isArray(status.recent) || status.cadenceDays !== 7 || !Number.isSafeInteger(status.starterArticles) || status.starterArticles < 0) throw new Error('SEO_STATUS_UNAVAILABLE');
      const last = new Date(status.lastRunAt);
      const observed = !!status.lastRunAt && Number.isFinite(last.getTime());
      const freshness = !status.enabled ? 'Paused' : !observed ? 'Worker has not been observed' : last - at > 30000 ? 'Worker timestamp is unverified' : at - last > 900000 ? 'Worker check is stale; publication needs investigation' : 'Worker check is recent';
      const time = value => value && Number.isFinite(new Date(value).getTime()) ? `${dubaiTime(new Date(value))} Dubai` : 'not recorded';
      const lines = ['BDFX • AUTO SEO / BLOG PUBLISHING', `Checked: ${dubaiTime(at)} Dubai`, `Publishing enabled: ${status.enabled ? 'Yes' : 'No'}`, `Worker: ${freshness}`, `Last check: ${time(status.lastRunAt)}`, `Last outcome: ${clean(status.lastOutcome, 40) || 'unrecorded'}`, `Last error: ${status.lastError ? (/^[a-z0-9_]+$/.test(status.lastError) ? status.lastError : 'redacted publication error') : 'none reported'}`, `Cadence: every ${status.cadenceDays} days`, `Starter library: ${status.starterArticles} articles`, `Queued drafts: ${status.queued.length}${status.queued.length === 12 ? '+ (preview limit)' : ''}`, `Next earliest publication: ${time(status.nextPublishAt)}`, '', 'Recent automatic publications:'];
      for (const article of status.recent.slice(0, 8)) lines.push(`${clean(article.title, 100)} | ${article.status === 'published' ? 'Published' : 'Currently not published'} | ${time(article.lastAutoPublishedAt)}`, `Slug: ${clean(article.slug, 110)}`);
      if (!status.recent.length) lines.push('No automatic publication recorded.');
      if (status.queued[0]) lines.push('', `Next queued guide: ${clean(status.queued[0].title, 110)}`);
      lines.push('', 'This is a finite educational starter series. Existing editorial SEO fields are preserved; empty metadata fields are completed on save. Publication does not prove Google indexing, rankings or traffic. Search Console/GA4 performance is not connected to this report.');
      reply = lines.join('\n');
    }
    else if (topic === 'pending_withdrawals') {
      const query = withdrawals.aggregate([
        { $match: { status: { $in: ['Pending', 'Processing'] } } },
        { $facet: {
          total: [{ $count: 'count' }],
          items: [
            { $sort: { createdAt: 1, _id: 1 } }, { $skip: (page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE },
            { $project: { _id: 0, orderid: 1, userId: 1, accountNo: 1, name: 1, currency: 1, cryptoSymbol: 1, amount: 1, status: 1, createdAt: 1 } },
            { $lookup: { from: 'users', let: { clientId: '$userId' }, pipeline: [
              { $match: { $expr: { $eq: ['$_id', '$$clientId'] } } }, { $project: { _id: 0, fullName: 1 } },
            ], as: 'client' } },
            { $project: { _id: 0, orderid: 1, accountNo: 1, currency: 1, cryptoSymbol: 1, amount: 1, status: 1, createdAt: 1,
              clientName: { $ifNull: [{ $arrayElemAt: ['$client.fullName', 0] }, '$name'] } } },
          ],
        } },
      ]);
      const rows = await (typeof query.option === 'function' ? query.option({ maxTimeMS: 10000 }) : query);
      if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0].total) || rows[0].total.length > 1 || !Array.isArray(rows[0].items)) throw new Error('QUEUE_UNAVAILABLE');
      const total = rows[0].total.length ? rows[0].total[0].count : 0;
      const items = rows[0].items;
      if (!Number.isSafeInteger(total) || total < 0 || items.length > PAGE_SIZE || items.length !== Math.max(0, Math.min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE))) throw new Error('QUEUE_UNAVAILABLE');
      const lines = ['BDFX • PENDING / PROCESSING WITHDRAWALS', `Checked: ${dubaiTime(at)} Dubai`, `Total requests: ${total} | Page ${page}`, 'Oldest requests first.'];
      if (!items.length) lines.push(total === 0 ? '\nNo pending or processing withdrawal requests.' : '\nNo requests on this page.');
      for (const [index, item] of items.entries()) {
        if (!['Pending', 'Processing'].includes(item.status)) throw new Error('QUEUE_UNAVAILABLE');
        const currency = ['INR', 'USD', 'VND'].includes(item.currency) ? item.currency
          : item.currency === 'CRYPTO' ? `CRYPTO (${clean(item.cryptoSymbol, 12) || 'asset unrecorded'})` : 'currency unrecorded';
        const amount = typeof item.amount === 'number' && Number.isFinite(item.amount) && item.amount >= 0
          ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 8 }).format(item.amount) : 'amount unavailable';
        const created = new Date(item.createdAt);
        const date = item.createdAt && Number.isFinite(created.getTime()) && created <= at ? `${dubaiTime(created)} Dubai` : 'date unavailable';
        lines.push('', `${(page - 1) * PAGE_SIZE + index + 1}. ${clean(item.clientName, 50) || 'Name unrecorded'}`,
          `MT5: ${clean(item.accountNo, 32) || 'unrecorded'} | ${amount} ${currency}`,
          `${item.status} | Requested: ${date}`, `Request: ${clean(item.orderid, 60) || 'unrecorded'}`);
      }
      if (total > page * PAGE_SIZE) lines.push('', `Next: /pending ${page + 1}`);
      lines.push('', 'Current queue snapshot. Requests are not bank settlements.');
      reply = lines.join('\n');
    } else {
      const report = await dailyReport();
      const formatted = formatBdfxDailyReport(report, at, false);
      if (!formatted.sourceVerified) throw new Error('REPORT_UNAVAILABLE');
      if (topic === 'report') reply = formatted.summary;
      else {
        const lines = [`BDFX • ${topic.toUpperCase()}`, `Checked: ${dubaiTime(new Date(report.generatedAt))} Dubai`, `Today: ${report.period.date}, 00:00 to check time`, ''];
        if (topic === 'deposits') {
          const d = report.depositRequestsToday;
          lines.push(`Deposit requests today: ${d.total}`, `Success: ${d.byStatus.SUCCESS} | Pending: ${d.byStatus.PENDING}`, `Partial: ${d.byStatus.PARTIALLY_PAID} | Failed: ${d.byStatus.FAILED} | Other: ${d.byStatus.other}`, '', 'Current status of today-created requests; not settlement amounts.');
        } else if (topic === 'withdrawals') {
          const d = report.withdrawalRequestsToday;
          lines.push(`Withdrawal requests today: ${d.total}`, `Completed: ${d.byStatus.Completed} | Pending: ${d.byStatus.Pending} | Processing: ${d.byStatus.Processing}`, `Failed: ${d.byStatus.Failed} | Rejected: ${d.byStatus.Rejected} | Other: ${d.byStatus.other}`, `All pending/processing requests: ${report.queues.pendingWithdrawals}`, '', 'Use /pending for client, MT5 account, amount and request details.');
        } else if (topic === 'clients') {
          const d = report.newRegistrations, all = report.registeredClients;
          lines.push(`New registrations today: ${d.total}`, `KYC approved: ${d.kycApproved} | Not approved: ${d.kycNotApproved}`, `All registered clients: ${all.total}`, `KYC approved: ${all.kycApproved} | Not approved: ${all.kycNotApproved}`, '', 'Email-verified registrations; unfinished OTP attempts excluded. Non-approved includes pending/incomplete cases.');
        } else if (topic === 'kyc') {
          const d = report.registeredClients;
          lines.push(`KYC approved: ${d.kycApproved} | Not approved: ${d.kycNotApproved}`, `Not started: ${d.byKycStatus.not_started} | In progress: ${d.byKycStatus.in_progress}`, `Review: ${d.byKycStatus.review} | Resubmit: ${d.byKycStatus.resubmission_requested}`, `Declined: ${d.byKycStatus.declined} | Other unapproved: ${d.byKycStatus.other_non_approved}`, '', 'Current KYC snapshot. Non-approved does not mean rejected.');
        } else if (topic === 'mt5') {
          lines.push(`New live MT5 accounts today: ${report.newLiveAccounts}`, '', 'This source counts new live accounts; balances, positions and trading P&L are not connected.');
        } else if (topic === 'ib') {
          lines.push(`Pending IB applications: ${report.queues.pendingIbApplications}`, '', 'Current queue count. Individual IB commission statements are not connected.');
        } else if (topic === 'tickets') {
          lines.push(`Open/pending support tickets: ${report.queues.openTickets}`, '', 'Current queue count. Ticket conversations are not shared in Telegram.');
        } else {
          const d = report.buddy;
          lines.push(`Saved sessions started: ${d.sessionsStarted}`, `With activity: ${d.sessionsWithActivity}`, `Contact requests: ${d.contactRequests} | Support handoffs: ${d.supportHandoffs}`, '', 'Consented saved sessions only; not every site visit.');
        }
        reply = lines.join('\n');
      }
    }
    if (reply.length > 3500) throw new Error('REPORT_TOO_LONG');
    return { version: 1, source: 'BDFX Telegram operations', generatedAt: at.toISOString(), topic, page, reply };
  };
}
module.exports = { createTelegramQueryService, TOPICS, PAGE_SIZE };
