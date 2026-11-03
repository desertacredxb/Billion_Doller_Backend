// A narrow reporting facade over the existing BDFX MT5 connection. No trade,
// balance-adjustment, user-management or arbitrary URL operation is exposed.
const MT5Request = require('../utils/mt5Request');
const PAGE_SIZE = 10;
const fail = code => Object.assign(new Error(code), { code });
const loginOk = value => typeof value === 'string' && /^[1-9]\d{3,11}$/.test(value) && Number.isSafeInteger(Number(value));
const pageOk = page => Number.isSafeInteger(page) && page >= 1 && page <= 999;
const decimal = value => (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))) && Number.isFinite(Number(value)) ? Number(value) : null;
const text = (value, length = 40) => typeof value === 'string' || typeof value === 'number' ? String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, length) : null;
function totalOf(answer) {
  const total = decimal(answer?.total);
  if (!Number.isSafeInteger(total) || total < 0) throw fail('MT5_SCHEMA_UNVERIFIED');
  return total;
}
function createMt5ReadService({ env = process.env, Request = MT5Request, now = () => new Date(), timeoutMs = 8000 } = {}) {
  let busy = false;
  return async function readMt5({ login, section, page = 1 }) {
    if (!loginOk(login) || !pageOk(page) || !['balance', 'positions', 'deals'].includes(section) || (section === 'balance' && page !== 1)) throw fail('INVALID_MT5_READ');
    if (busy) throw fail('MT5_READ_BUSY');
    if (!['MT5_SERVER', 'MT5_MANAGER_LOGIN', 'MT5_MANAGER_PASSWORD', 'MT5_BUILD'].every(k => env[k])) throw fail('MT5_NOT_CONFIGURED');
    busy = true;
    let mt5;
    try {
      mt5 = new Request(env.MT5_SERVER, 1950);
      const baseGet = mt5.Get.bind(mt5);
      // The legacy MT5 integration also contains mutating GET methods. A GET
      // method check alone would be unsafe: permit these exact paths only.
      mt5.Get = (path, callback) => {
        const pathname = path.split('?')[0];
        if (!['/api/auth/start', '/api/auth/answer', '/api/user/account/get', '/api/deal/get_total', '/api/deal/get_page', '/api/position/get_total', '/api/position/get_page'].includes(pathname)) return callback(fail('MT5_PATH_DENIED'));
        let done = false;
        const finish = (...args) => { if (done) return; done = true; clearTimeout(timer); callback(...args); };
        const timer = setTimeout(() => { mt5.https.destroy(); finish(fail('MT5_READ_TIMEOUT')); }, timeoutMs);
        try { baseGet(path, finish); } catch { finish(fail('MT5_READ_UNAVAILABLE')); }
      };
      await new Promise((resolve, reject) => mt5.Auth(env.MT5_MANAGER_LOGIN, env.MT5_MANAGER_PASSWORD, env.MT5_BUILD, 'WebManager', error => error ? reject(fail('MT5_AUTH_UNAVAILABLE')) : resolve()));
      const read = path => new Promise((resolve, reject) => mt5.Get(path, (error, response, body) => {
        if (error) return reject(fail(error.code === 'MT5_READ_TIMEOUT' ? error.code : 'MT5_READ_UNAVAILABLE'));
        if (response?.statusCode !== 200 || typeof body !== 'string' || body.length > 262144) return reject(fail('MT5_READ_UNAVAILABLE'));
        try {
          const data = JSON.parse(body);
          if (!/^0(?:\s|$)/.test(String(data?.retcode))) throw fail('MT5_READ_UNAVAILABLE');
          if (!Object.hasOwn(data, 'answer')) throw fail('MT5_SCHEMA_UNVERIFIED');
          resolve(data.answer);
        } catch { reject(fail('MT5_READ_UNAVAILABLE')); }
      }));
      const query = 'login=' + encodeURIComponent(login);
      if (section === 'balance') {
        const account = await read('/api/user/account/get?' + query);
        if (!account || Array.isArray(account) || String(account.Login) !== login) throw fail('MT5_ACCOUNT_MISMATCH');
        const fields = { balance: 'Balance', credit: 'Credit', equity: 'Equity', margin: 'Margin', freeMargin: 'MarginFree', floatingProfit: 'Profit' };
        const values = Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, decimal(account[field])]));
        if (values.balance === null || values.equity === null) throw fail('MT5_SCHEMA_UNVERIFIED');
        return { source: 'MT5 Web API', live: true, checkedAt: now().toISOString(), section, page, ...values };
      }
      const end = Math.floor(now().getTime() / 1000);
      const kind = section === 'deals' ? 'deal' : 'position';
      const scope = section === 'deals' ? `&from=0&to=${end}` : '';
      const total = totalOf(await read(`/api/${kind}/get_total?${query}${scope}`));
      const offset = (page - 1) * PAGE_SIZE;
      const rows = offset < total ? await read(`/api/${kind}/get_page?${query}${scope}&offset=${offset}&total=${PAGE_SIZE}`) : [];
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE || (offset < total && !rows.length)) throw fail('MT5_SCHEMA_UNVERIFIED');
      const items = rows.map(row => {
        if (!row || typeof row !== 'object' || String(row.Login) !== login) throw fail('MT5_ACCOUNT_MISMATCH');
        const base = { ticket: text(section === 'deals' ? row.Deal : row.Position), symbol: text(row.Symbol, 24), action: text(row.Action, 8), volumeUnits: text(row.Volume, 24), profit: decimal(row.Profit) };
        if (!base.ticket || base.profit === null) throw fail('MT5_SCHEMA_UNVERIFIED');
        if (section === 'deals') return { ...base, time: decimal(row.Time), entry: text(row.Entry, 8), price: decimal(row.Price), commission: decimal(row.Commission), swap: decimal(row.Storage), fee: decimal(row.Fee) };
        return { ...base, openedAt: decimal(row.TimeCreate), openPrice: decimal(row.PriceOpen), currentPrice: decimal(row.PriceCurrent), stopLoss: decimal(row.PriceSL), takeProfit: decimal(row.PriceTP), swap: decimal(row.Storage) };
      });
      return { source: 'MT5 Web API', live: true, checkedAt: now().toISOString(), section, page, total, hasMore: total > page * PAGE_SIZE, items,
        coverage: section === 'deals' ? { fromUnix: 0, toUnix: end, order: 'MT5 provider page order; not guaranteed newest first' } : 'Current open positions only; count and page are sequential snapshots' };
    } catch (error) {
      throw fail(['MT5_NOT_CONFIGURED', 'MT5_READ_BUSY', 'MT5_READ_TIMEOUT', 'MT5_AUTH_UNAVAILABLE', 'MT5_ACCOUNT_MISMATCH', 'MT5_SCHEMA_UNVERIFIED'].includes(error?.code) ? error.code : 'MT5_READ_UNAVAILABLE');
    } finally { mt5?.https.destroy(); busy = false; }
  };
}
module.exports = { createMt5ReadService, loginOk, pageOk, decimal, text, PAGE_SIZE };
