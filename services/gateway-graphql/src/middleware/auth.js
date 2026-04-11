'use strict';

const crypto = require('node:crypto');

/**
 * Verifies a HS256 JWT using Node built-ins only (no external deps).
 * Returns decoded payload or throws.
 */
function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const [headerB64, payloadB64, sigB64] = parts;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  if (expected !== sigB64) throw new Error('Invalid JWT signature');

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT expired');
  }
  return payload;
}

/**
 * Express middleware — attaches decoded JWT claims to req.user.
 * Requests without a valid Bearer token receive 401.
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ error: 'JWT_SECRET not configured' });
  }

  try {
    req.user = verifyJwt(token, secret);
    next();
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }
}

/**
 * Role guard factory.
 * Usage: requireRole('ADMIN')(req, res, next)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Forbidden — requires one of: ${roles.join(', ')}`,
      });
    }
    next();
  };
}

module.exports = { authMiddleware, requireRole, verifyJwt };
