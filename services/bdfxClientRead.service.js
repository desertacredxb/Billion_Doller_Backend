const Account = require('../models/account.model');
const User = require('../models/User');
const Order = require('../models/Order');
const Withdrawal = require('../models/withdrawal');
const { createMt5ReadService, loginOk, pageOk, decimal, text, PAGE_SIZE } = require('./bdfxMt5Read.service');
const { GROUP_ID } = require('../integrations/n8n/bdfx-telegram-questions');
const SECTIONS = ['profile', 'balance', 'positions', 'deals', 'deposits', 'withdrawals'];
const fail = code => Object.assign(new Error(code), { code });
function verifiedAdmin(context, now = new Date()) {
  if (!context || Array.isArray(context) || Object.keys(context).sort().join(',') !== 'checkedAt,groupId,role,senderId') return false;
  const at = new Date(context.checkedAt);
  return context.groupId === GROUP_ID && ['creator', 'administrator'].includes(context.role) && Number.isSafeInteger(context.senderId) && context.senderId > 0
    && typeof context.checkedAt === 'string' && Number.isFinite(at.getTime()) && now - at >= -30000 && now - at <= 120000;
}
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
async function aggregate(model, pipeline) { const result = model.aggregate(pipeline); return typeof result.option === 'function' ? result.option({ maxTimeMS: 8000 }) : result; }
async function pageRows(model, match, project, page) {
  const rows = await aggregate(model, [{ $match: match }, { $facet: { total: [{ $count: 'count' }], items: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }, { $project: project }] } }]);
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]?.total) || rows[0].total.length > 1 || !Array.isArray(rows[0].items) || rows[0].items.length > PAGE_SIZE) throw fail('CLIENT_SOURCE_UNAVAILABLE');
  const total = rows[0].total.length ? rows[0].total[0].count : 0;
  if (!Number.isSafeInteger(total) || total < 0 || rows[0].items.length !== Math.max(0, Math.min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE))) throw fail('CLIENT_SOURCE_UNAVAILABLE');
  return { total, items: rows[0].items, page, hasMore: total > page * PAGE_SIZE };
}
function createClientReadService({ accounts = Account, users = User, orders = Order, withdrawals = Withdrawal, mt5 = createMt5ReadService(), now = () => new Date() } = {}) {
  const envelope = data => ({ version: 1, source: 'BDFX private client reporting', generatedAt: now().toISOString(), ...data });
  return {
    async list(page, context) {
      if (!verifiedAdmin(context, now())) throw fail('BDFX_ADMIN_REQUIRED');
      if (!pageOk(page)) throw fail('INVALID_CLIENT_READ');
      const rows = await aggregate(accounts, [{ $match: { accountType: 'LIVE', userType: 'CLIENT' } },
        { $lookup: { from: 'users', let: { uid: '$user' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$_id', '$$uid'] }, { $eq: ['$isVerified', true] }] } } }, { $project: { _id: 0, fullName: 1 } }], as: 'owner' } },
        { $match: { 'owner.0': { $exists: true } } }, { $facet: { total: [{ $count: 'count' }], items: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: (page - 1) * PAGE_SIZE }, { $limit: PAGE_SIZE }, { $project: { _id: 0, accountNo: 1, currency: 1, fullName: { $arrayElemAt: ['$owner.fullName', 0] }, createdAt: 1 } }] } }]);
      const row = rows?.[0], total = row?.total?.length === 0 ? 0 : row?.total?.[0]?.count;
      if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(row.total) || row.total.length > 1 || !Number.isSafeInteger(total) || total < 0 || !Array.isArray(row.items) || row.items.length !== Math.max(0, Math.min(PAGE_SIZE, total - (page - 1) * PAGE_SIZE))) throw fail('CLIENT_SOURCE_UNAVAILABLE');
      const items = row.items.map(a => { if (!loginOk(String(a.accountNo))) throw fail('CLIENT_SOURCE_UNAVAILABLE'); return { login: String(a.accountNo), name: text(a.fullName, 50), currency: text(a.currency, 12), createdAt: date(a.createdAt) }; });
      return envelope({ section: 'accounts', page, total, hasMore: total > page * PAGE_SIZE, items, coverage: 'Verified BDFX clients with LIVE CLIENT accounts. Newest account records first; no live balances are implied.' });
    },
    async read({ login, section, page }, context) {
      if (!verifiedAdmin(context, now())) throw fail('BDFX_ADMIN_REQUIRED');
      if (!loginOk(login) || !SECTIONS.includes(section) || !pageOk(page) || (['profile', 'balance'].includes(section) && page !== 1)) throw fail('INVALID_CLIENT_READ');
      // Explicit inclusion projections prevent stored account passwords, identity
      // documents, contact data and payment credentials reaching the model.
      const account = await accounts.findOne({ accountNo: Number(login), accountType: 'LIVE', userType: 'CLIENT' }).select({ _id: 1, user: 1, accountNo: 1, currency: 1, createdAt: 1 }).maxTimeMS(8000).lean();
      const user = account && await users.findOne({ _id: account.user, isVerified: true }).select({ _id: 1, fullName: 1, isVerified: 1, isKycVerified: 1, createdAt: 1 }).maxTimeMS(8000).lean();
      if (!account || !user || String(account.accountNo) !== login) throw fail('BDFX_ACCOUNT_NOT_FOUND');
      const identity = { login, name: text(user.fullName, 50), currency: text(account.currency, 12), currencySource: 'BDFX account record' };
      if (section === 'profile') return envelope({ ...identity, section, page, registeredAt: date(user.createdAt), emailVerified: user.isVerified === true, kycApproved: user.isKycVerified === true, accountCreatedAt: date(account.createdAt), coverage: 'Registration/KYC status and this trading account. Ask for deposits, withdrawals or MT5 deals separately; no bank, contact or ID-document history is included.' });
      if (['balance', 'positions', 'deals'].includes(section)) return envelope({ ...identity, ...await mt5({ login, section, page }), version: 1, source: 'BDFX private client reporting', upstreamSource: 'MT5 Web API', generatedAt: now().toISOString() });
      const result = section === 'deposits'
        ? await pageRows(orders, { account: account._id, accountNo: login }, { _id: 0, orderid: 1, amount: 1, creditedAmount: 1, status: 1, createdAt: 1 }, page)
        : await pageRows(withdrawals, { userId: user._id, accountNo: login }, { _id: 0, orderid: 1, amount: 1, currency: 1, cryptoSymbol: 1, amountUSD: 1, status: 1, createdAt: 1 }, page);
      const statuses = section === 'deposits' ? ['PENDING', 'PARTIALLY_PAID', 'SUCCESS', 'FAILED'] : ['Pending', 'Processing', 'Completed', 'Failed', 'Rejected'];
      const items = result.items.map(item => {
        if (!statuses.includes(item.status)) throw fail('CLIENT_SOURCE_UNAVAILABLE');
        const base = { request: text(item.orderid, 50), amount: decimal(item.amount), status: item.status, requestedAt: date(item.createdAt) };
        return section === 'deposits' ? { ...base, currency: 'not recorded on order', creditedUsd: decimal(item.creditedAmount) }
          : { ...base, currency: ['INR', 'USD', 'VND'].includes(item.currency) ? item.currency : item.currency === 'CRYPTO' ? `CRYPTO (${text(item.cryptoSymbol, 12) || 'asset unrecorded'})` : 'not recorded', amountUsd: decimal(item.amountUSD) };
      });
      return envelope({ ...identity, ...result, items, section, coverage: 'All stored requests for this BDFX account, newest first, ten per page. Request status and credited/deducted values are not independent bank settlement evidence. Amounts remain separate by currency.' });
    },
  };
}
module.exports = { createClientReadService, verifiedAdmin, SECTIONS };
