-- rate_cards
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'rate_cards')
BEGIN
  CREATE TABLE rate_cards (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    insurer       VARCHAR(100)  NOT NULL,
    file_name     VARCHAR(500),
    effective_from DATE,
    effective_to   DATE          NULL,
    uploaded_at   DATETIME      DEFAULT GETDATE(),
    status        VARCHAR(50)   DEFAULT 'active'
  );
END;
-- Idempotent column add for older deployments missing `effective_to`.
-- When a new rate card is uploaded with effective_from = D, the upload
-- route closes out all previously-active cards for the same insurer by
-- setting their effective_to = D.  Cards with effective_to IS NULL are
-- considered open-ended (current).  The /export/all endpoint filters to
-- cards active "today": effective_from <= today AND (effective_to IS NULL
-- OR effective_to > today).
IF COL_LENGTH('rate_cards', 'effective_to') IS NULL
BEGIN
  ALTER TABLE rate_cards ADD effective_to DATE NULL;
END;

-- Bulk Calc cache uses cycle_runs as a snapshot.  Track which insurer
-- filter was active when the snapshot was built so /calculate knows
-- whether to reuse or recompute on a different filter (e.g. "All
-- insurers" after the snapshot was built for one insurer).
IF OBJECT_ID('cycle_runs', 'U') IS NOT NULL
   AND COL_LENGTH('cycle_runs', 'snapshot_insurer_slug') IS NULL
BEGIN
  ALTER TABLE cycle_runs ADD snapshot_insurer_slug VARCHAR(100) NULL;
END;

-- rate_rules
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'rate_rules')
BEGIN
  CREATE TABLE rate_rules (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    rate_card_id    INT           REFERENCES rate_cards(id),
    insurer         VARCHAR(100),
    product         VARCHAR(100),
    sheet_name      VARCHAR(200),
    region          VARCHAR(200),
    segment         VARCHAR(300),
    make            VARCHAR(200),
    model           VARCHAR(200),
    sub_type        VARCHAR(100),
    fuel_type       VARCHAR(50),
    cc_band_min     INT,
    cc_band_max     INT,
    weight_band_min DECIMAL(10,2),
    weight_band_max DECIMAL(10,2),
    age_band_min    INT,
    age_band_max    INT,
    vehicle_age_min INT,
    vehicle_age_max INT,
    seating_capacity_min INT,
    seating_capacity_max INT,
    volume_tier     VARCHAR(100),
    addon           VARCHAR(50),
    carrier_type    VARCHAR(100),
    rate_type       VARCHAR(50),
    rate_value      DECIMAL(10,4),
    is_declined     BIT           DEFAULT 0,
    rate_text       VARCHAR(500),
    is_conditional  BIT           DEFAULT 0,
    discount_pct    DECIMAL(5,2),
    created_at      DATETIME      DEFAULT GETDATE()
  );
END;

-- discount_pct — added for Shriram (DIS % column on broker grid). Other
-- insurers can fill it whenever they expose discount info in their grids.
IF NOT EXISTS (SELECT * FROM sys.columns
               WHERE object_id = OBJECT_ID('rate_rules') AND name = 'discount_pct')
  ALTER TABLE rate_rules ADD discount_pct DECIMAL(5,2) NULL;

-- state — first-class state column (added 2026-05). Previously state was
-- packed into sub_type in the "Royal-style" convention (region=city,
-- sub_type=state). Engines should now emit `state` directly; sub_type
-- continues to mean "fine-grained qualifier". The excel-export prefers
-- rule.state when present, falling back to the legacy Royal-style detection
-- so older cards still render correctly.
IF NOT EXISTS (SELECT * FROM sys.columns
               WHERE object_id = OBJECT_ID('rate_rules') AND name = 'state')
  ALTER TABLE rate_rules ADD state VARCHAR(200) NULL;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_rate_rules_state')
  CREATE INDEX IX_rate_rules_state ON rate_rules (state);

-- applied_on — engine-emitted flag indicating which premium leg the rate
-- applies to ('OD' / 'TP' / 'NET' / 'OD_TP').  Required so the export's
-- mergeOdTpPairs can pair OD-half and TP-half COMP rules emitted from
-- per-fuel or per-premium-band grids (e.g. Future Generali CV IMD).
IF NOT EXISTS (SELECT * FROM sys.columns
               WHERE object_id = OBJECT_ID('rate_rules') AND name = 'applied_on')
  ALTER TABLE rate_rules ADD applied_on VARCHAR(10) NULL;

-- rate_rules indexes
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_rate_rules_insurer')
  CREATE INDEX IX_rate_rules_insurer ON rate_rules (insurer);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_rate_rules_product')
  CREATE INDEX IX_rate_rules_product ON rate_rules (product);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_rate_rules_region')
  CREATE INDEX IX_rate_rules_region ON rate_rules (region);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_rate_rules_segment')
  CREATE INDEX IX_rate_rules_segment ON rate_rules (segment);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_rate_rules_rate_card_id')
  CREATE INDEX IX_rate_rules_rate_card_id ON rate_rules (rate_card_id);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_rate_rules_composite')
  CREATE INDEX IX_rate_rules_composite ON rate_rules (insurer, product, region, segment);

-- rto_mappings
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'rto_mappings')
BEGIN
  CREATE TABLE rto_mappings (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    rate_card_id  INT           REFERENCES rate_cards(id),
    insurer       VARCHAR(100),
    product       VARCHAR(100),
    rto_code      VARCHAR(20),
    region        VARCHAR(200),
    cluster       VARCHAR(200)
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_rto_mappings_lookup')
  CREATE INDEX IX_rto_mappings_lookup ON rto_mappings (insurer, product, rto_code);

-- conditional_rates
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'conditional_rates')
BEGIN
  CREATE TABLE conditional_rates (
    id              INT IDENTITY(1,1) PRIMARY KEY,
    rate_rule_id    INT           REFERENCES rate_rules(id),
    condition_type  VARCHAR(50),
    condition_min   INT,
    condition_max   INT,
    condition_text  VARCHAR(200),
    rate_value      DECIMAL(10,4)
  );
END;

-- margin_rules — user-defined margins that apply to a filter predicate.
-- description    : free-text natural-language condition (e.g. "chola gcv 2.5-5T chennai")
-- filters_json   : canonical filter object parsed from the description
-- filter_signature: deterministic key used to detect duplicates / conflicts
-- margin_pct     : margin percent to subtract from rate (outgoing = rate − margin)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'margin_rules')
BEGIN
  CREATE TABLE margin_rules (
    id                INT IDENTITY(1,1) PRIMARY KEY,
    description       NVARCHAR(500) NOT NULL,
    filters_json      NVARCHAR(MAX) NOT NULL,
    filter_signature  NVARCHAR(500) NOT NULL,
    margin_pct        DECIMAL(6,3)  NOT NULL,
    created_at        DATETIME      DEFAULT GETDATE(),
    updated_at        DATETIME      DEFAULT GETDATE(),
    created_by        NVARCHAR(100) DEFAULT 'Admin',
    active            BIT           DEFAULT 1
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_margin_rules_signature')
  CREATE UNIQUE INDEX IX_margin_rules_signature ON margin_rules(filter_signature) WHERE active = 1;

-- statement_uploads — one record per uploaded insurer statement (month file)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'statement_uploads')
BEGIN
  CREATE TABLE statement_uploads (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    insurer_slug  VARCHAR(100) NOT NULL,
    insurer_label NVARCHAR(200),   -- the label used in the mapping file header
    month         INT NOT NULL,     -- 1..12
    year          INT NOT NULL,
    file_name     NVARCHAR(500),
    row_count     INT DEFAULT 0,
    matched_count INT DEFAULT 0,    -- how many rows matched a Prarambh policy
    total_amount  DECIMAL(18,2) DEFAULT 0,
    uploaded_at   DATETIME DEFAULT GETDATE(),
    uploaded_by   NVARCHAR(100) DEFAULT 'Admin',
    status        VARCHAR(20) DEFAULT 'active'
  );
END;

-- statement_rows — one record per policy row parsed from a statement
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'statement_rows')
BEGIN
  CREATE TABLE statement_rows (
    id               INT IDENTITY(1,1) PRIMARY KEY,
    upload_id        INT REFERENCES statement_uploads(id),
    insurer_slug     VARCHAR(100),
    policy_no        NVARCHAR(200),
    amount           DECIMAL(18,2),   -- total commission (PointOut)
    od_commission    DECIMAL(18,2),
    addon_commission DECIMAL(18,2),
    tp_commission    DECIMAL(18,2),
    pa_commission    DECIMAL(18,2),
    terror_commission DECIMAL(18,2),
    net_amount       DECIMAL(18,2),
    gross_amount     DECIMAL(18,2),
    reward           DECIMAL(18,2),
    raw_json         NVARCHAR(MAX),   -- full parsed row, for audit
    created_at       DATETIME DEFAULT GETDATE()
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_statement_rows_policy_no')
  CREATE INDEX IX_statement_rows_policy_no ON statement_rows(policy_no);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_statement_rows_upload_id')
  CREATE INDEX IX_statement_rows_upload_id ON statement_rows(upload_id);

-- pr_uploads — one record per uploaded Premium Register (per insurer + month)
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'pr_uploads')
BEGIN
  CREATE TABLE pr_uploads (
    id             INT IDENTITY(1,1) PRIMARY KEY,
    insurer_slug   VARCHAR(100) NOT NULL,
    insurer_label  NVARCHAR(200),
    month          INT NOT NULL,      -- 1..12
    year           INT NOT NULL,
    file_name      NVARCHAR(500),
    row_count      INT DEFAULT 0,
    total_net      DECIMAL(18,2) DEFAULT 0,
    total_gross    DECIMAL(18,2) DEFAULT 0,
    total_od       DECIMAL(18,2) DEFAULT 0,
    total_tp       DECIMAL(18,2) DEFAULT 0,
    uploaded_at    DATETIME DEFAULT GETDATE(),
    uploaded_by    NVARCHAR(100) DEFAULT 'Admin',
    status         VARCHAR(20) DEFAULT 'active'
  );
END;

-- pr_rows — one record per policy in the Premium Register
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'pr_rows')
BEGIN
  CREATE TABLE pr_rows (
    id               INT IDENTITY(1,1) PRIMARY KEY,
    upload_id        INT REFERENCES pr_uploads(id),
    insurer_slug     VARCHAR(100),
    policy_no        NVARCHAR(200),
    customer_name    NVARCHAR(300),
    vehicle_no       NVARCHAR(100),
    vehicle_make     NVARCHAR(200),
    vehicle_model    NVARCHAR(200),
    sub_model        NVARCHAR(200),
    cc               INT,
    tonnage          DECIMAL(10,2),
    seating          INT,
    fuel_type        NVARCHAR(50),
    mfg_year         NVARCHAR(20),
    sum_insured      DECIMAL(18,2),
    ncb              DECIMAL(6,2),
    vehicle_type     NVARCHAR(100),
    vehicle_category NVARCHAR(200),
    product          NVARCHAR(200),
    zero_dep         NVARCHAR(10),
    od_premium       DECIMAL(18,2),
    total_od_premium DECIMAL(18,2),
    addon_premium    DECIMAL(18,2),
    tp_premium       DECIMAL(18,2),
    net_amount       DECIMAL(18,2),
    gst              DECIMAL(18,2),
    gross_amount     DECIMAL(18,2),
    pa_cover         DECIMAL(18,2),
    pr_status        NVARCHAR(50),
    policy_issued_date NVARCHAR(50),
    od_start_date    NVARCHAR(50),
    od_end_date      NVARCHAR(50),
    tp_start_date    NVARCHAR(50),
    tp_end_date      NVARCHAR(50),
    state            NVARCHAR(200),
    region           NVARCHAR(200),
    raw_json         NVARCHAR(MAX),
    created_at       DATETIME DEFAULT GETDATE()
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_pr_rows_policy_no')
  CREATE INDEX IX_pr_rows_policy_no ON pr_rows(policy_no);
IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_pr_rows_upload_id')
  CREATE INDEX IX_pr_rows_upload_id ON pr_rows(upload_id);

-- payout_cycles — user-defined billing cycles (name + date window).
-- Surfaced as a dropdown on Bulk Calculation and Payout Summary so users can
-- pick "March-1st-Cycle" (Mar 1–16) instead of re-typing date ranges.
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'payout_cycles')
BEGIN
  CREATE TABLE payout_cycles (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    name       NVARCHAR(200) NOT NULL,
    date_from  DATE NOT NULL,
    date_to    DATE NOT NULL,
    active     BIT DEFAULT 1,
    created_at DATETIME DEFAULT GETDATE(),
    created_by NVARCHAR(100) DEFAULT 'Admin'
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_payout_cycles_range')
  CREATE INDEX IX_payout_cycles_range ON payout_cycles(date_from, date_to);

-- special_rate_rules — agent-specific margin overrides. Each row is keyed
-- by (upincode, filter_signature) so an agent can have at most one override
-- per scope. The override either:
--   a) Hard-replaces the default margin (override_margin_pct, no tiers).
--   b) Defines premium-volume tiers (volume_tiers_json) — at calc time we
--      look up the agent's accumulated premium for the configured window
--      and pick the tier whose [premium_min..premium_max] contains it.
-- window_type ∈ ('month','cycle','date_range'). When 'date_range', use
-- window_from / window_to. When 'cycle', the active payout_cycle's dates
-- are resolved at calc time.
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'special_rate_rules')
BEGIN
  CREATE TABLE special_rate_rules (
    id                  INT IDENTITY(1,1) PRIMARY KEY,
    upincode            NVARCHAR(50)  NOT NULL,
    pos_name            NVARCHAR(200) NULL,
    description         NVARCHAR(500) NOT NULL,
    filters_json        NVARCHAR(MAX) NOT NULL,
    filter_signature    NVARCHAR(500) NOT NULL,
    override_margin_pct DECIMAL(6,3)  NULL,
    volume_tiers_json   NVARCHAR(MAX) NULL,
    window_type         VARCHAR(20)   NULL,
    window_from         DATE          NULL,
    window_to           DATE          NULL,
    created_at          DATETIME      DEFAULT GETDATE(),
    updated_at          DATETIME      DEFAULT GETDATE(),
    created_by          NVARCHAR(100) DEFAULT 'Admin',
    active              BIT           DEFAULT 1
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_special_rate_rules_agent_sig')
  CREATE UNIQUE INDEX IX_special_rate_rules_agent_sig
    ON special_rate_rules(upincode, filter_signature) WHERE active = 1;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_special_rate_rules_upin')
  CREATE INDEX IX_special_rate_rules_upin ON special_rate_rules(upincode) WHERE active = 1;

-- agent_global_uplifts — single per-agent uplift % that applies to EVERY
-- margin scope unless a more-specific row in special_rate_rules overrides
-- it. Uplift is stored as the bonus the agent receives (positive number =
-- agent gets that much more outgoing); the calc subtracts it from the
-- default margin to compute the effective margin.
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'agent_global_uplifts')
BEGIN
  CREATE TABLE agent_global_uplifts (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    upincode    NVARCHAR(50)  NOT NULL,
    pos_name    NVARCHAR(200) NULL,
    uplift_pct  DECIMAL(6,3)  NOT NULL,
    note        NVARCHAR(500) NULL,
    created_at  DATETIME      DEFAULT GETDATE(),
    updated_at  DATETIME      DEFAULT GETDATE(),
    created_by  NVARCHAR(100) DEFAULT 'Admin',
    active      BIT           DEFAULT 1
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_agent_global_uplifts_upin')
  CREATE UNIQUE INDEX IX_agent_global_uplifts_upin
    ON agent_global_uplifts(upincode) WHERE active = 1;

-- parsed_remarks_cache — caches LLM-extracted structured fields for unique
-- UW remarks strings so each remark is only sent to the model once.
-- Key is sha256 of the verbatim remark text.
IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'parsed_remarks_cache')
BEGIN
  CREATE TABLE parsed_remarks_cache (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    remark_hash   CHAR(64)        NOT NULL,
    remark_text   NVARCHAR(MAX)   NOT NULL,
    json_extract  NVARCHAR(MAX)   NOT NULL,
    model         VARCHAR(100)    NOT NULL,
    parsed_at     DATETIME        DEFAULT GETDATE()
  );
END;

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'IX_parsed_remarks_cache_hash')
  CREATE UNIQUE INDEX IX_parsed_remarks_cache_hash
    ON parsed_remarks_cache(remark_hash);
