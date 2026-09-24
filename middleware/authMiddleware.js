const jwt = require("jsonwebtoken");

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (typeof authHeader !== 'string' || !/^Bearer [^\s]+$/i.test(authHeader)) {
    return res.status(401).json({ message: "Access denied. No token." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded !== 'object' || typeof decoded.id !== 'string' ||
        !/^[a-f\d]{24}$/i.test(decoded.id) || (decoded.sub !== undefined && decoded.sub !== decoded.id)) {
      return res.status(401).json({ message: 'Invalid token' });
    }
    // Roles and ownership are always loaded from the database, never JWT claims.
    req.user = { id: decoded.id.toLowerCase() };
    next();
  } catch (err) {
    res.status(401).json({ message: "Invalid token" });
  }
};

module.exports = authMiddleware;
