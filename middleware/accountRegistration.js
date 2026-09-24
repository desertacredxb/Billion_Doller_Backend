// The customer portal creates CLIENT trading accounts only. Never forward
// arbitrary registration fields or a customer-selected administrator type.
module.exports = (req, res, next) => {
  const { email, curr, actype, Utype, Ref, Password } = req.body || {};
  if (Utype !== undefined && Utype !== 'CLIENT') {
    return res.status(403).json({ message: 'Only client trading accounts can be created here.' });
  }
  req.body = { email, curr, actype, Utype: 'CLIENT', Ref, Password };
  next();
};
