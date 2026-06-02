// override: .env wins over any pre-existing process env vars (e.g. an
// empty ANTHROPIC_API_KEY inherited from the parent shell).
require('dotenv').config({ override: true });

const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');

const uploadRoutes = require('./routes/upload');
const ratesRoutes = require('./routes/rates');
const metaRoutes = require('./routes/meta');
const policyRoutes = require('./routes/policy');
const exportRoutes = require('./routes/export');
const finalRatesRoutes = require('./routes/final-rates');
const marginsRoutes = require('./routes/margins');
const specialRatesRoutes = require('./routes/special-rates');
const bulkRoutes = require('./routes/bulk');
const statementsRoutes = require('./routes/statements');
const payoutRoutes = require('./routes/payout');
const prRoutes = require('./routes/pr');
const adminRoutes = require('./routes/admin');
const cyclesRoutes = require('./routes/cycles');
const cycleBulkRoutes = require('./routes/cycle-bulk');
const mastersRoutes = require('./routes/masters');
const authRoutes = require('./routes/auth');
const companyMarginRoutes = require('./routes/company-margin');
const reconRoutes = require('./routes/recon');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');

// Middleware
app.use(cors());
app.use(express.json());
// Serve static files with no-cache headers so repeated edits to index.html /
// script / stylesheet are picked up without users having to hard-refresh.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));

// Multer setup for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${timestamp}_${safeName}`);
  },
});
const upload = multer({ storage });

// Attach multer middleware to upload routes
app.use('/api/upload', upload.single('file'), uploadRoutes);
app.use('/api/rates', ratesRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/policy', policyRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/final-rates', upload.single('file'), finalRatesRoutes);
app.use('/api/margins', marginsRoutes);
app.use('/api/special-rates', specialRatesRoutes);
app.use('/api/bulk', bulkRoutes);
app.use('/api/statements', upload.single('file'), statementsRoutes);
app.use('/api/payout', payoutRoutes);
app.use('/api/pr', upload.single('file'), prRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/cycles', cyclesRoutes);
app.use('/api/cycle-bulk', cycleBulkRoutes);
app.use('/api/masters', mastersRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/company-margins', companyMarginRoutes);
app.use('/api/recon', reconRoutes);
app.use('/api/agent', require('./routes/agent'));
app.use('/api/employee', require('./routes/employee'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[RateExtract] Error:', err.message);
  console.error(err.stack);

  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
  });
});

app.listen(PORT, () => {
  console.log(`[RateExtract] Server running on port ${PORT}`);
  console.log(`[RateExtract] Upload directory: ${UPLOAD_DIR}`);
});

module.exports = app;
