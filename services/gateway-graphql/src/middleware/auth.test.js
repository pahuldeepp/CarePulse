'use strict';

const crypto = require('node:crypto');
const { verifyJwt, authMiddleware, requireRole } = require('./auth');

// ── helpers ───────────────────────────────────────────────────────────────────
function makeToken(payload, secret, opts = {}) {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig     = crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  if (opts.badSig)   return `${header}.${body}.badsignature`;
  if (opts.noSig)    return `${header}.${body}`;
  return `${header}.${body}.${sig}`;
}

// ── verifyJwt ─────────────────────────────────────────────────────────────────
describe('verifyJwt', () => {
  const SECRET  = 'test-secret';
  const payload = { userId: 'u1', tenantId: 't1', role: 'ADMIN' };

  it('returns decoded payload for a valid token', () => {
    const token  = makeToken(payload, SECRET);
    const result = verifyJwt(token, SECRET);
    expect(result.userId).toBe('u1');
    expect(result.role).toBe('ADMIN');
  });

  it('throws on malformed token (wrong number of parts)', () => {
    expect(() => verifyJwt('only.two', SECRET)).toThrow('Malformed JWT');
  });

  it('throws on invalid signature', () => {
    const token = makeToken(payload, SECRET, { badSig: true });
    expect(() => verifyJwt(token, SECRET)).toThrow('Invalid JWT signature');
  });

  it('throws on expired token', () => {
    const expired = makeToken({ ...payload, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET);
    expect(() => verifyJwt(expired, SECRET)).toThrow('JWT expired');
  });

  it('accepts token with future exp', () => {
    const valid = makeToken({ ...payload, exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
    expect(() => verifyJwt(valid, SECRET)).not.toThrow();
  });
});

// ── authMiddleware ────────────────────────────────────────────────────────────
describe('authMiddleware', () => {
  const SECRET  = 'test-secret';
  const payload = { userId: 'u1', tenantId: 't1', role: 'CLINICIAN' };

  const mockRes = () => {
    const res = {};
    res.status  = jest.fn().mockReturnValue(res);
    res.json    = jest.fn().mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    process.env.JWT_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it('calls next() and sets req.user for a valid token', () => {
    const token = makeToken(payload, SECRET);
    const req   = { headers: { authorization: `Bearer ${token}` } };
    const res   = mockRes();
    const next  = jest.fn();

    authMiddleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.tenantId).toBe('t1');
  });

  it('returns 401 when Authorization header is missing', () => {
    const req  = { headers: {} };
    const res  = mockRes();
    const next = jest.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid token', () => {
    const req  = { headers: { authorization: 'Bearer bad.token.here' } };
    const res  = mockRes();
    const next = jest.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 500 when JWT_SECRET is not configured', () => {
    delete process.env.JWT_SECRET;
    const req  = { headers: { authorization: 'Bearer anything' } };
    const res  = mockRes();
    const next = jest.fn();

    authMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── requireRole ───────────────────────────────────────────────────────────────
describe('requireRole', () => {
  const mockRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json   = jest.fn().mockReturnValue(res);
    return res;
  };

  it('calls next() when user has the required role', () => {
    const req  = { user: { role: 'ADMIN' } };
    const res  = mockRes();
    const next = jest.fn();

    requireRole('ADMIN', 'CLINICIAN')(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 403 when user lacks the required role', () => {
    const req  = { user: { role: 'VIEWER' } };
    const res  = mockRes();
    const next = jest.fn();

    requireRole('ADMIN')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when req.user is absent', () => {
    const req  = {};
    const res  = mockRes();
    const next = jest.fn();

    requireRole('ADMIN')(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });
});
