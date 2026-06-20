-- ============================================================================
-- OCR Bulk Upload — schema deltas.
-- Node only INSERTS upload rows; the existing OCR processor writes trackers.
-- The shared tables (Prarambh_Live) are used as-is; we only add a PolicyNo
-- column to trn_OCRBulkEntry so the processor can store the policy number, and
-- the Excel export can read (Trackerno, PolicyNo).
--
-- Run this block against Prarambh_Live:
-- ----------------------------------------------------------------------------
IF COL_LENGTH('dbo.trn_OCRBulkEntry', 'PolicyNo') IS NULL
  ALTER TABLE dbo.trn_OCRBulkEntry ADD PolicyNo VARCHAR(200) NULL;

-- ----------------------------------------------------------------------------
-- Run this block against the RateExtract app DB (db/connection getPool):
-- A small Node-owned table so the tab can show "X PDFs in folder" and link a
-- Trn_PrarambhOCRBulkUploadDetails row to its entries — WITHOUT altering the
-- shared tables.
--
-- IF OBJECT_ID('dbo.ocr_bulk_meta', 'U') IS NULL
-- CREATE TABLE dbo.ocr_bulk_meta (
--   upload_id   INT PRIMARY KEY,            -- Prarambh_Live Trn_PrarambhOCRBulkUploadDetails.id
--   folder_name NVARCHAR(500) NULL,         -- original zip name
--   folder_key  NVARCHAR(500) NULL,         -- zip name without .zip (matches entry FolderPath)
--   total_pdfs  INT NOT NULL DEFAULT 0,
--   emp_code    NVARCHAR(100) NULL,
--   created_at  DATETIME NOT NULL DEFAULT GETDATE()
-- );
-- ============================================================================
