const sql = require('mssql');

// Remote DB on WAN → bump timeouts; retry once after a fresh pool when a
// previously-cached pool goes stale (network hiccup, DB restart, etc.).
// Build connection config. `port` is OPTIONAL — when DB_PORT is unset, we
// let mssql talk to SQL Browser to discover the (named) instance, OR rely
// on the default 1433 if a default instance is configured.  Required for
// servers like localhost\SQLEXPRESS using dynamic ports.
const config = {
  server: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'RateExtract',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeout: parseInt(process.env.DB_CONNECT_TIMEOUT, 10) || 30000,
  requestTimeout:    parseInt(process.env.DB_REQUEST_TIMEOUT, 10) || 60000,
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
    // Tolerate a few retries when a freshly-acquired connection races with
    // the server closing an idle one.
    acquireTimeoutMillis: 30000,
  },
  options: {
    encrypt: false,
    trustServerCertificate: process.env.DB_TRUST_CERT === 'true',
    // Keep-alive so LAN→WAN NAT timeouts don't silently kill idle sockets.
    enableArithAbort: true,
  },
};

// Append port only when explicitly set — avoids forcing 1433 on a server
// using dynamic ports / named instance.
if (process.env.DB_PORT) {
  const p = parseInt(process.env.DB_PORT, 10);
  if (Number.isFinite(p)) config.port = p;
}

// Server like "localhost\SQLEXPRESS" → split into server + instanceName
// (the mssql driver does NOT parse the backslash on its own).
if (typeof config.server === 'string' && config.server.includes('\\')) {
  const [host, instance] = config.server.split('\\');
  config.server = host;
  config.options = config.options || {};
  config.options.instanceName = instance;
}

let pool = null;
let pending = null;   // guards concurrent getPool() calls while a connect is in flight

function attachErrorHandler(p) {
  p.on('error', (err) => {
    console.error('[RateExtract] pool error — resetting:', err.message);
    if (pool === p) pool = null;
  });
}

async function connectOnce() {
  const p = new sql.ConnectionPool(config);
  await p.connect();
  attachErrorHandler(p);
  return p;
}

async function getPool() {
  if (pool && pool.connected) return pool;
  if (pending) return pending;
  pending = (async () => {
    try {
      // First try: reuse any half-initialised pool reference, or create new.
      pool = await connectOnce();
      return pool;
    } catch (err) {
      // Give the remote one retry after a short delay — transient WAN glitches
      // on the first connect otherwise bubble straight to the client.
      console.error('[RateExtract] initial connect failed:', err.message, '— retrying in 2s');
      await new Promise(r => setTimeout(r, 2000));
      pool = await connectOnce();
      return pool;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

async function close() {
  if (pool) {
    try { await pool.close(); } catch (_) { /* noop */ }
    pool = null;
  }
}

module.exports = { getPool, close };
