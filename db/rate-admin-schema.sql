-- ============================================================================
-- Manual Rate Editor — audit log. Run against the RateExtract app DB (getPool).
-- Every manual add/update to a rate_rules row is logged here (who / what / old→new).
-- Idempotent.
-- ============================================================================
IF OBJECT_ID('dbo.rate_rule_audit', 'U') IS NULL
CREATE TABLE dbo.rate_rule_audit (
  id         BIGINT IDENTITY(1,1) PRIMARY KEY,
  rule_id    INT           NULL,                 -- rate_rules.id (null only if the row vanished)
  insurer    VARCHAR(100)  NULL,
  product    VARCHAR(50)   NULL,
  action     VARCHAR(10)   NOT NULL,             -- 'update' | 'insert'
  old_rate   DECIMAL(10,4) NULL,                 -- null on insert
  new_rate   DECIMAL(10,4) NULL,
  empcode    NVARCHAR(100) NULL,                 -- who made the change
  note       NVARCHAR(500) NULL,
  at         DATETIME      NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_rate_rule_audit_rule' AND object_id = OBJECT_ID('dbo.rate_rule_audit'))
  CREATE INDEX IX_rate_rule_audit_rule ON dbo.rate_rule_audit (rule_id, at);
