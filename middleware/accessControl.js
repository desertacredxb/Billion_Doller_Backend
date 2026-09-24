const User = require('../models/User');
const Account = require('../models/account.model');

const ID = /^[a-f\d]{24}$/i;
function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? email.toLowerCase() : null;
}

function createAccessControl({ UserModel = User, AccountModel = Account, env = process.env } = {}) {
  async function loadPrincipal(req, res, next) {
    if (typeof req.user?.id !== 'string' || !ID.test(req.user.id)) return res.status(401).json({ message: 'Sign in to continue.' });
    try {
      const user = await UserModel.findById(req.user.id, '_id email fullName isVerified');
      if (!user || user.isVerified !== true || !normalizeEmail(user.email)) {
        return res.status(401).json({ message: 'A verified account is required.' });
      }
      const id = String(user._id).toLowerCase();
      if (id !== req.user.id.toLowerCase()) return res.status(401).json({ message: 'Invalid account.' });
      const admins = new Set(String(env.BDFX_ADMIN_USER_IDS || '').split(',')
        .map(value => value.trim().toLowerCase()).filter(value => ID.test(value)));
      req.principal = { id, email: user.email, isAdmin: admins.has(id) };
      req.principalUser = { id, email: user.email, fullName: user.fullName };
      next();
    } catch { return res.status(503).json({ message: 'Unable to validate account access.' }); }
  }

  function requireAdmin(req, res, next) {
    if (!req.principal) return res.status(401).json({ message: 'Sign in to continue.' });
    if (req.principal.isAdmin !== true) return res.status(403).json({ message: 'Administrator access is required.' });
    next();
  }

  function emailGuard(source, key, allowAdmin) {
    if (!['params', 'body', 'query'].includes(source) || typeof key !== 'string') throw new Error('Invalid email access rule');
    return (req, res, next) => {
      if (!req.principal) return res.status(401).json({ message: 'Sign in to continue.' });
      const supplied = normalizeEmail(req[source]?.[key]);
      if (!supplied) return res.status(400).json({ message: 'A valid account email is required.' });
      if (supplied === normalizeEmail(req.principal.email)) {
        // Preserve stored casing for the existing exact-match database queries.
        req[source][key] = req.principal.email;
        return next();
      }
      if (allowAdmin && req.principal.isAdmin === true) {
        req[source][key] = supplied;
        return next();
      }
      return res.status(403).json({ message: 'This account cannot access another user.' });
    };
  }

  function requireAccountOwner(source, key) {
    const keys = Array.isArray(key) ? key : [key];
    if (!['params', 'body', 'query'].includes(source) || !keys.length || keys.some(value => typeof value !== 'string')) {
      throw new Error('Invalid account access rule');
    }
    return async (req, res, next) => {
      if (!req.principal) return res.status(401).json({ message: 'Sign in to continue.' });
      const values = keys.map(name => req[source]?.[name]).filter(value => value !== undefined);
      const numbers = values.map(value => typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value.trim())) ? Number(value) : NaN);
      if (!numbers.length || numbers.some(value => !Number.isSafeInteger(value) || value <= 0 || value !== numbers[0])) {
        return res.status(400).json({ message: 'A valid, consistent account number is required.' });
      }
      try {
        const account = await AccountModel.findOne({ accountNo: numbers[0] }, '_id accountNo user');
        if (!account || (req.principal.isAdmin !== true && String(account.user) !== req.principal.id)) {
          return res.status(403).json({ message: 'This trading account is not available to you.' });
        }
        req.authorizedAccount = { id: String(account._id), accountNo: account.accountNo, userId: String(account.user) };
        next();
      } catch { return res.status(503).json({ message: 'Unable to validate trading account access.' }); }
    };
  }

  return { loadPrincipal, requireAdmin,
    requireOwnerEmail: (source, key) => emailGuard(source, key, false),
    requireOwnerOrAdminEmail: (source, key) => emailGuard(source, key, true), requireAccountOwner };
}

module.exports = { ...createAccessControl(), createAccessControl, normalizeEmail };
