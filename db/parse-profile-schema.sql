-- ─────────────────────────────────────────────────────────────────────────────
-- card_parse_profiles — one row per (rate_card, sheet). Stores HOW a sheet was
-- parsed: the dynamically-detected layout (flat | matrix), the column→role map
-- (or matrix descriptor), the rate divisor, and health metrics. This makes every
-- parse reproducible + auditable, and lets a human review/correct a drifted
-- layout instead of the engine silently mis-parsing it.
--
-- Idempotent: safe to run repeatedly.
-- ─────────────────────────────────────────────────────────────────────────────
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'card_parse_profiles')
BEGIN
  CREATE TABLE card_parse_profiles (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    rate_card_id   INT           NOT NULL,
    insurer        NVARCHAR(100) NULL,
    product        NVARCHAR(40)  NULL,
    sheet_name     NVARCHAR(255) NULL,
    source_path    NVARCHAR(500) NULL,      -- stored upload file, for re-parse
    layout         NVARCHAR(20)  NULL,      -- 'flat' | 'matrix'
    profile_json   NVARCHAR(MAX) NULL,      -- full serialised profile (roles/headers/matrix descriptor/divisor)
    confidence     FLOAT         NULL,
    coverage       FLOAT         NULL,      -- rows-with-rule / data-rows
    empty_rate_pct FLOAT         NULL,      -- data-rows that produced no rule
    data_rows      INT           NULL,
    rules_out      INT           NULL,
    status         NVARCHAR(20)  NOT NULL DEFAULT 'auto',  -- auto | needs_review | confirmed | rejected
    notes          NVARCHAR(MAX) NULL,
    created_at     DATETIME      DEFAULT GETDATE(),
    confirmed_by   NVARCHAR(100) NULL,
    confirmed_at   DATETIME      NULL
  );
  CREATE INDEX IX_cpp_card   ON card_parse_profiles (rate_card_id);
  CREATE INDEX IX_cpp_status ON card_parse_profiles (status);
END;

-- Record the stored upload path on the card too, so ANY card can be re-parsed
-- (older cards predate the profile table). Idempotent column add.
IF COL_LENGTH('rate_cards', 'source_path') IS NULL
  ALTER TABLE rate_cards ADD source_path NVARCHAR(500) NULL;
