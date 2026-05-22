const sql = require('mssql');

/**
 * Prarambh_UAT connection — hosts the App_UPloadPointsdetails stored procedure
 * used by the Upload Final Rates tab.
 */
const config = {
  server: process.env.PRARAMBH_UAT_HOST || '103.224.240.11',
  port: parseInt(process.env.PRARAMBH_UAT_PORT, 10) || 57115,
  database: process.env.PRARAMBH_UAT_NAME || 'Prarambh_UAT',
  user: process.env.PRARAMBH_UAT_USER || 'santoshy',
  password: process.env.PRARAMBH_UAT_PASSWORD || 'S@n7osh',
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  connectionTimeout: 15000,
  requestTimeout: 300000,
};

let pool = null;

async function getPrarambhUatPool() {
  if (!pool) {
    pool = await new sql.ConnectionPool(config).connect();
    console.log('[RateExtract] Connected to Prarambh_UAT DB');
  }
  return pool;
}

async function close() {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

module.exports = { getPrarambhUatPool, close };
