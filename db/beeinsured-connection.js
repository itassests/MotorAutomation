const sql = require('mssql');

/**
 * Beeinsured_v3_2 connection — hosts tmp_poscodes used by the Payout Summary
 * and Bulk Calculation flows to look up agent names by UPIN code.
 *
 * Defaults assume the DB lives on the same host as Prarambh_Live (103.224.240.90)
 * but with database = Beeinsured_v3_2. Override via env vars (BEEINSURED_HOST,
 * BEEINSURED_PORT, BEEINSURED_NAME, BEEINSURED_USER, BEEINSURED_PASSWORD) when
 * it's on a different server.
 */
const config = {
  server:   process.env.BEEINSURED_HOST || process.env.PRARAMBH_DB_HOST || '103.224.240.90',
  port:     parseInt(process.env.BEEINSURED_PORT, 10) || parseInt(process.env.PRARAMBH_DB_PORT, 10) || 57116,
  database: process.env.BEEINSURED_NAME || 'Beeinsured_v3_2',
  user:     process.env.BEEINSURED_USER || process.env.PRARAMBH_DB_USER || 'Ramakrishna',
  password: process.env.BEEINSURED_PASSWORD || process.env.PRARAMBH_DB_PASSWORD || 'R!m@krish#123',
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  connectionTimeout: 15000,
  requestTimeout: 60000,
};

let pool = null;

async function getBeeinsuredPool() {
  if (!pool) {
    pool = await new sql.ConnectionPool(config).connect();
    console.log('[RateExtract] Connected to Beeinsured_v3_2 DB');
  }
  return pool;
}

async function close() {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

module.exports = { getBeeinsuredPool, close };
