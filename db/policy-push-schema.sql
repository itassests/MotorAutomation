-- ============================================================================
-- Policy Push to Mobile App — schema.
-- Node-owned durable queue + state. Run against the RateExtract app DB
-- (db/connection.js getPool()). Prarambh_Live is the read-only source and is
-- NOT altered.
--
-- Idempotent: safe to run repeatedly.
-- ============================================================================

-- Durable work queue + audit. One row per policy (keyed by Prarambh main id).
IF OBJECT_ID('dbo.policy_push_queue', 'U') IS NULL
CREATE TABLE dbo.policy_push_queue (
  id                BIGINT IDENTITY(1,1) PRIMARY KEY,
  prarambh_main_id  BIGINT       NOT NULL,               -- TRN_PrarambhMain.Id — stable identity
  tracker_no        NVARCHAR(200) NULL,                  -- TRN_PrarambhMain.TrackerNo
  policy_no         NVARCHAR(200) NULL,                  -- resolved at push time (blank at submission)
  submission_date   DATE          NOT NULL,              -- drives dashboard + daily enqueue
  status            TINYINT       NOT NULL DEFAULT 1,    -- 1 pending / 2 pushed / 3 failed / 4 in-progress
  retry             INT           NOT NULL DEFAULT 0,
  error             NVARCHAR(MAX) NULL,                  -- last error message
  payload_json      NVARCHAR(MAX) NULL,                  -- last payload sent (audit + correct/repush source)
  pushed_at         DATETIME      NULL,
  created_at        DATETIME      NOT NULL DEFAULT GETDATE(),
  updated_at        DATETIME      NOT NULL DEFAULT GETDATE()
);

-- Unique identity → duplicate enqueue is impossible (seeder/daily use WHERE NOT EXISTS).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UQ_policy_push_identity' AND object_id = OBJECT_ID('dbo.policy_push_queue'))
  CREATE UNIQUE INDEX UQ_policy_push_identity ON dbo.policy_push_queue (prarambh_main_id);

-- Cheap claim scan for the worker (status=1 pending).
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_policy_push_status' AND object_id = OBJECT_ID('dbo.policy_push_queue'))
  CREATE INDEX IX_policy_push_status ON dbo.policy_push_queue (status) INCLUDE (id, retry);

-- Dashboard GROUP BY + daily-date filter.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_policy_push_subdate' AND object_id = OBJECT_ID('dbo.policy_push_queue'))
  CREATE INDEX IX_policy_push_subdate ON dbo.policy_push_queue (submission_date, status);

-- Singleton state row (backfill cursor + last daily run).
IF OBJECT_ID('dbo.policy_push_meta', 'U') IS NULL
CREATE TABLE dbo.policy_push_meta (
  meta_key            VARCHAR(20)  NOT NULL PRIMARY KEY,  -- always 'default'
  backfill_started_at DATETIME     NULL,                  -- set once when backfill kicks off (guard)
  backfill_cursor_id  BIGINT       NULL,                  -- resumable ascending-Id cursor
  backfill_done       BIT          NOT NULL DEFAULT 0,
  backfill_seeded     INT          NOT NULL DEFAULT 0,    -- rows enqueued by the seeder
  last_daily_date     DATE         NULL                   -- last submission-date enqueued by the daily job
);

IF NOT EXISTS (SELECT 1 FROM dbo.policy_push_meta WHERE meta_key = 'default')
  INSERT INTO dbo.policy_push_meta (meta_key) VALUES ('default');
