const sql = require('mssql');

const config = {
  server: process.env.PRARAMBH_DB_HOST || '103.224.240.90',
  port: parseInt(process.env.PRARAMBH_DB_PORT, 10) || 57116,
  database: process.env.PRARAMBH_DB_NAME || 'Prarambh_Live',
  user: process.env.PRARAMBH_DB_USER || 'Ramakrishna',
  password: process.env.PRARAMBH_DB_PASSWORD || 'R!m@krish#123',
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  connectionTimeout: 15000,
  requestTimeout: 180000, // 3 minutes — bulk calc pulls larger ranges
};

let pool = null;

async function getPrarambhPool() {
  if (!pool) {
    pool = await new sql.ConnectionPool(config).connect();
    console.log('[RateExtract] Connected to Prarambh_Live DB');
  }
  return pool;
}

async function close() {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

module.exports = { getPrarambhPool, close };
