require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { getPool, close } = require('./connection');

async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf-8');

  let pool;
  try {
    console.log('Connecting to database...');
    pool = await getPool();

    console.log('Running schema migration...');
    await pool.request().batch(sql);

    console.log('Migration completed successfully.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

migrate();
