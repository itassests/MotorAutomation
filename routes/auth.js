/**
 * routes/auth.js — Empcode + OTP login.
 *
 * For now, OTP is hardcoded to `387040`. The frontend collects empcode →
 * /login (stub) → enters OTP → /verify-otp → token. Tokens are HMAC-signed
 * payloads keyed by AUTH_SECRET (env) so they survive restarts but aren't
 * forgeable.
 *
 * Routes:
 *   POST /api/auth/login         body: { empcode }
 *   POST /api/auth/verify-otp    body: { empcode, otp }     → { token, user }
 *   GET  /api/auth/me            (Bearer token)             → { user }
 *   GET  /api/auth/users         admin only                 → [users]
 *   POST /api/auth/users         admin only — create user
 *   PUT  /api/auth/users/:emp    admin only — update permissions / role / active
 *   DELETE /api/auth/users/:emp  admin only — soft-delete (active = 0)
 */
const express = require('express');
const crypto = require('crypto');
const sql = require('mssql');
const { getPool } = require('../db/connection');

const router = express.Router();
router.use(express.json());

// Hardcoded OTP per spec. Swap for a real provider (SMS / email) later by
// implementing /login to dispatch and storing per-empcode codes server-side.
const FIXED_OTP = '387040';

const SECRET = process.env.AUTH_SECRET || 'dev-secret-change-me';
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;   // 12 hours

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expected) return null;
  let p; try { p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || !p.exp || p.exp < Date.now()) return null;
  return p;
}

/** Express middleware — populates req.user from the Bearer token. */
function attachUser() {
  return async (req, res, next) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || '');
    const payload = verify(token);
    if (!payload) return next();
    try {
      const pool = await getPool();
      const r = await pool.request().input('e', sql.NVarChar(100), payload.empcode)
        .query('SELECT TOP 1 empcode, name, role, permissions_json, active FROM app_users WHERE empcode = @e');
      if (r.recordset.length === 0 || r.recordset[0].active === false) return next();
      const u = r.recordset[0];
      let perms = {};
      try { perms = JSON.parse(u.permissions_json || '{}'); } catch (_) { /* ignore */ }
      req.user = { empcode: u.empcode, name: u.name, role: u.role, permissions: perms };
    } catch (_) { /* fall through unauthenticated */ }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' });
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, error: 'Admin access required' });
  next();
}

// ── Public routes ──────────────────────────────────────────────────────────

/** POST /login — accept empcode, pretend to dispatch an OTP. The real OTP is
 *  hardcoded server-side (see FIXED_OTP) until SMS/email is wired. */
router.post('/login', async (req, res) => {
  const empcode = String((req.body && req.body.empcode) || '').trim().toUpperCase();
  if (!empcode) return res.status(400).json({ success: false, error: 'empcode required' });
  // Don't leak whether the empcode exists — pretend an OTP is dispatched
  // either way. The verify step is the real gate.
  res.json({ success: true, message: 'OTP sent', otp_hint: 'Use the test OTP for now (provided separately)' });
});

/** POST /verify-otp — exchange empcode + OTP for a session token. Auto-creates
 *  the user on first login with default permissions (read-only on all
 *  screens). Existing admin record stays admin. */
router.post('/verify-otp', async (req, res, next) => {
  try {
    const empcode = String((req.body && req.body.empcode) || '').trim().toUpperCase();
    const otp     = String((req.body && req.body.otp) || '').trim();
    if (!empcode || !otp) return res.status(400).json({ success: false, error: 'empcode + otp required' });
    if (otp !== FIXED_OTP) return res.status(401).json({ success: false, error: 'Invalid OTP' });

    // Agents log in with their POSLG… UPIN. They get the dedicated 'agent' role
    // (Agent View only — see applyPermissions), scoped to their own data.
    const isAgent = /^POSLG/i.test(empcode);
    const pool = await getPool();
    // Upsert user with safe defaults so first-time logins work immediately.
    const existing = await pool.request().input('e', sql.NVarChar(100), empcode)
      .query('SELECT empcode, name, role, permissions_json, active FROM app_users WHERE empcode = @e');
    let user;
    if (existing.recordset.length === 0) {
      // First-time login. POSLG → agent (Agent View only); others → read-only
      // regular user an admin can promote later.
      const role = isAgent ? 'agent' : 'user';
      const defaultPerms = isAgent ? { all: false, agent: true, screens: {} } : { all: false, screens: {} };
      await pool.request()
        .input('e', sql.NVarChar(100), empcode)
        .input('r', sql.NVarChar(20), role)
        .input('p', sql.NVarChar(sql.MAX), JSON.stringify(defaultPerms))
        .query(`INSERT INTO app_users (empcode, name, role, permissions_json)
                VALUES (@e, @e, @r, @p)`);
      user = { empcode, name: empcode, role, permissions: defaultPerms };
    } else {
      const u = existing.recordset[0];
      if (u.active === false) return res.status(403).json({ success: false, error: 'User is disabled' });
      let perms = {};
      try { perms = JSON.parse(u.permissions_json || '{}'); } catch (_) { /* ignore */ }
      let role = u.role;
      // A POSLG login is always an agent (unless explicitly an admin) — coerce
      // legacy 'user' rows so the prefix rule holds regardless of signup order.
      if (isAgent && role !== 'admin') { role = 'agent'; perms = { ...perms, agent: true }; }
      user = { empcode: u.empcode, name: u.name, role, permissions: perms };
    }
    await pool.request().input('e', sql.NVarChar(100), empcode)
      .query('UPDATE app_users SET last_login = GETDATE() WHERE empcode = @e');

    const token = sign({ empcode: user.empcode, role: user.role, exp: Date.now() + TOKEN_TTL_MS });
    res.json({ success: true, token, user });
  } catch (err) { next(err); }
});

/** GET /me — current user from the token. Powers the SPA bootstrap. */
router.get('/me', attachUser(), (req, res) => {
  if (!req.user) return res.status(401).json({ success: false, error: 'Unauthenticated' });
  res.json({ success: true, user: req.user });
});

// ── Admin user-management routes ───────────────────────────────────────────

router.get('/users', attachUser(), requireAdmin, async (req, res, next) => {
  try {
    const pool = await getPool();
    const r = await pool.request().query(
      `SELECT empcode, name, role, permissions_json, active, last_login, created_at
       FROM app_users ORDER BY (CASE WHEN active = 1 THEN 0 ELSE 1 END), created_at DESC`
    );
    const users = r.recordset.map(u => {
      let perms = {};
      try { perms = JSON.parse(u.permissions_json || '{}'); } catch (_) { /* ignore */ }
      return { ...u, permissions: perms };
    });
    res.json({ success: true, count: users.length, users });
  } catch (err) { next(err); }
});

router.post('/users', attachUser(), requireAdmin, async (req, res, next) => {
  try {
    const empcode = String((req.body && req.body.empcode) || '').trim().toUpperCase();
    const name    = String((req.body && req.body.name) || '').trim() || empcode;
    const role    = (req.body && req.body.role) === 'admin' ? 'admin' : 'user';
    const perms   = (req.body && req.body.permissions) || { all: false, screens: {} };
    if (!empcode) return res.status(400).json({ success: false, error: 'empcode required' });
    const pool = await getPool();
    await pool.request()
      .input('e', sql.NVarChar(100), empcode)
      .input('n', sql.NVarChar(300), name)
      .input('r', sql.VarChar(20), role)
      .input('p', sql.NVarChar(sql.MAX), JSON.stringify(perms))
      .query(`IF EXISTS (SELECT 1 FROM app_users WHERE empcode = @e)
                UPDATE app_users SET name = @n, role = @r, permissions_json = @p, active = 1 WHERE empcode = @e
              ELSE
                INSERT INTO app_users (empcode, name, role, permissions_json) VALUES (@e, @n, @r, @p)`);
    res.json({ success: true, empcode });
  } catch (err) { next(err); }
});

router.put('/users/:empcode', attachUser(), requireAdmin, async (req, res, next) => {
  try {
    const empcode = String(req.params.empcode || '').trim().toUpperCase();
    const sets = [];
    const pool = await getPool();
    const rq = pool.request().input('e', sql.NVarChar(100), empcode);
    const b = req.body || {};
    if ('name' in b)        { sets.push('name = @n');             rq.input('n', sql.NVarChar(300), String(b.name || '').trim() || empcode); }
    if ('role' in b)        { sets.push('role = @r');             rq.input('r', sql.VarChar(20), b.role === 'admin' ? 'admin' : 'user'); }
    if ('permissions' in b) { sets.push('permissions_json = @p'); rq.input('p', sql.NVarChar(sql.MAX), JSON.stringify(b.permissions || {})); }
    if ('active' in b)      { sets.push('active = @a');           rq.input('a', sql.Bit, b.active ? 1 : 0); }
    if (sets.length === 0)  return res.status(400).json({ success: false, error: 'no fields to update' });
    const r = await rq.query(`UPDATE app_users SET ${sets.join(', ')} WHERE empcode = @e`);
    if (r.rowsAffected[0] === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/users/:empcode', attachUser(), requireAdmin, async (req, res, next) => {
  try {
    const empcode = String(req.params.empcode || '').trim().toUpperCase();
    if (empcode === 'ADMIN') return res.status(400).json({ success: false, error: 'Cannot delete the default Admin' });
    const pool = await getPool();
    await pool.request().input('e', sql.NVarChar(100), empcode)
      .query('UPDATE app_users SET active = 0 WHERE empcode = @e');
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.attachUser = attachUser;
module.exports.requireAdmin = requireAdmin;
