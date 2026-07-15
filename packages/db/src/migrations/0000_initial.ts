// Single source of truth for the initial schema. Hand-written SQL with IF NOT EXISTS so
// the same script can re-run against a fresh schema without erroring. Drizzle types in
// packages/db/src/schema mirror these tables; this SQL is what integration tests apply.

export const INITIAL_SQL = `
-- Operators -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_operators (
  id            TEXT PRIMARY KEY,
  handle        TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Source shops (the operator's reference 1688 shop list, etc.)
CREATE TABLE IF NOT EXISTS source_shops (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES local_operators(id),
  handle        TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (operator_id, handle)
);

-- Products -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id               TEXT PRIMARY KEY,
  operator_id      TEXT NOT NULL REFERENCES local_operators(id),
  source_url       TEXT NOT NULL,
  source_item_id   TEXT,
  locale           TEXT NOT NULL DEFAULT 'th-TH',
  currency         TEXT NOT NULL DEFAULT 'THB',
  canonical_success_detail_id TEXT,
  state_automation TEXT NOT NULL DEFAULT 'not_started',
  state_asset_archive TEXT NOT NULL DEFAULT 'pending',
  state_listing    TEXT NOT NULL DEFAULT 'pending',
  state_canvas     TEXT NOT NULL DEFAULT 'not_started',
  state_approval   TEXT NOT NULL DEFAULT 'unapproved',
  state_miaoshou_edit TEXT NOT NULL DEFAULT 'not_started',
  state_source     TEXT NOT NULL DEFAULT 'not_started',
  version          BIGINT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Preserve every legacy product and revision before enforcing stable identity. Prefer
-- the row that already has a known canonical detail; duplicate rows remain addressable
-- by id/source_url but relinquish source_item_id so no history is deleted or merged.
WITH ranked_product_identities AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY operator_id, source_item_id
           ORDER BY (canonical_success_detail_id IS NOT NULL) DESC, created_at ASC, id ASC
         ) AS identity_rank
  FROM products
  WHERE source_item_id IS NOT NULL
)
UPDATE products product
SET source_item_id = NULL,
    updated_at = now()
FROM ranked_product_identities ranked
WHERE product.id = ranked.id AND ranked.identity_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS products_operator_source_item_unique
  ON products (operator_id, source_item_id)
  WHERE source_item_id IS NOT NULL;

-- Product revisions: immutable per round of automation
CREATE TABLE IF NOT EXISTS product_revisions (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  draft_version    INTEGER NOT NULL,
  source_title     TEXT,
  source_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  working_draft    JSONB NOT NULL DEFAULT '{}'::jsonb,
  version          BIGINT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, draft_version)
);

CREATE TABLE IF NOT EXISTS miaoshou_source_records (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_item_id   TEXT NOT NULL,
  fetch_detail_id  TEXT,
  skipped_detail_id TEXT,
  canonical_success_detail_id TEXT,
  failure_reason   TEXT,
  fetched_payload  JSONB NOT NULL DEFAULT '{}'::jsonb,
  state            TEXT NOT NULL DEFAULT 'not_started',
  version          BIGINT NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Forward-compatible for local Wave 1 databases that already created the table.
ALTER TABLE miaoshou_source_records ADD COLUMN IF NOT EXISTS fetch_detail_id TEXT;
ALTER TABLE miaoshou_source_records ADD COLUMN IF NOT EXISTS skipped_detail_id TEXT;
ALTER TABLE miaoshou_source_records ADD COLUMN IF NOT EXISTS canonical_success_detail_id TEXT;
ALTER TABLE miaoshou_source_records ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- Earlier Wave 1 builds stored an ambiguous detail_id. It is safe only as the fetch
-- response id; canonical success must be resolved again from source records/API.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'miaoshou_source_records'
      AND column_name = 'detail_id'
  ) THEN
    EXECUTE $legacy$
      UPDATE miaoshou_source_records
      SET fetch_detail_id = COALESCE(fetch_detail_id, detail_id),
          failure_reason = COALESCE(failure_reason, 'legacy_detail_id_requires_reparse'),
          updated_at = now()
      WHERE detail_id IS NOT NULL
        AND (fetch_detail_id IS NULL OR failure_reason IS NULL)
    $legacy$;
  END IF;
END
$migration$;

-- Source records are attempt/history rows, so duplicate source identities are valid.
DROP INDEX IF EXISTS miaoshou_source_records_product_source_unique;

CREATE TABLE IF NOT EXISTS skus (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision_id      TEXT REFERENCES product_revisions(id) ON DELETE SET NULL,
  sku_key          TEXT NOT NULL,
  attributes       JSONB NOT NULL DEFAULT '{}'::jsonb,
  price_minor      TEXT,
  price_currency   TEXT,
  stock            INTEGER,
  weight_value     TEXT,
  weight_unit      TEXT,
  dimensions       JSONB,
  image_url        TEXT,
  version          BIGINT NOT NULL DEFAULT 1,
  UNIQUE (product_id, sku_key)
);

CREATE TABLE IF NOT EXISTS sku_dimensions (
  id               TEXT PRIMARY KEY,
  sku_id           TEXT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  value            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision_id      TEXT REFERENCES product_revisions(id) ON DELETE SET NULL,
  remote_url       TEXT NOT NULL,
  kind             TEXT NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  width            INTEGER,
  height           INTEGER,
  sha256           TEXT,
  local_path       TEXT,
  extension        TEXT,
  perceptual_hash  TEXT,
  clarity          DOUBLE PRECISION,
  duplicate_distance INTEGER,
  watermark_probability DOUBLE PRECISION,
  collage_probability DOUBLE PRECISION,
  non_product_probability DOUBLE PRECISION,
  visual_score     DOUBLE PRECISION,
  chosen_role      TEXT,
  rejection_reason TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE assets ADD COLUMN IF NOT EXISTS local_path TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS extension TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS perceptual_hash TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS clarity DOUBLE PRECISION;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS duplicate_distance INTEGER;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS watermark_probability DOUBLE PRECISION;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS collage_probability DOUBLE PRECISION;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS non_product_probability DOUBLE PRECISION;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS visual_score DOUBLE PRECISION;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS chosen_role TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

WITH duplicate_assets AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY product_id, remote_url
    ORDER BY created_at ASC, id ASC
  ) AS duplicate_rank
  FROM assets
)
DELETE FROM assets
WHERE id IN (SELECT id FROM duplicate_assets WHERE duplicate_rank > 1);

CREATE UNIQUE INDEX IF NOT EXISTS assets_product_remote_unique
  ON assets(product_id, remote_url);

CREATE TABLE IF NOT EXISTS listing_drafts (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision_id      TEXT NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE,
  draft_version    INTEGER NOT NULL,
  target_locale    TEXT NOT NULL,
  style            TEXT NOT NULL,
  title            TEXT,
  description      TEXT,
  attributes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider         TEXT,
  model            TEXT,
  fallback_used    BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listing_generation_runs (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision_id      TEXT NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE,
  draft_version    INTEGER NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  provider         TEXT,
  model            TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_runs (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision_id      TEXT NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE,
  draft_version    INTEGER NOT NULL,
  state            TEXT NOT NULL DEFAULT 'pending',
  breakdown        JSONB NOT NULL DEFAULT '{}'::jsonb,
  final_price_minor TEXT,
  final_currency    TEXT,
  ending             TEXT,
  exchange_rate_snapshot_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exchange_rate_snapshots (
  id               TEXT PRIMARY KEY,
  base             TEXT NOT NULL,
  target           TEXT NOT NULL,
  rate             TEXT NOT NULL,
  source           TEXT NOT NULL,
  observed_at      TIMESTAMPTZ NOT NULL,
  is_stale         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id               TEXT PRIMARY KEY,
  revision_id      TEXT NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE,
  processing_version INTEGER NOT NULL,
  state            TEXT NOT NULL DEFAULT 'queued',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (revision_id, processing_version)
);

CREATE TABLE IF NOT EXISTS canvas_runs (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision_id      TEXT NOT NULL REFERENCES product_revisions(id) ON DELETE CASCADE,
  template_id      TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  state            TEXT NOT NULL DEFAULT 'not_started',
  workflow_id      TEXT,
  workflow_version INTEGER,
  remote_task_id   TEXT,
  outputs          JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS canvas_daily_reservations (
  day_key          DATE NOT NULL,
  slot             INTEGER NOT NULL CHECK (slot > 0),
  run_key          TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day_key, slot),
  UNIQUE (day_key, run_key)
);

CREATE TABLE IF NOT EXISTS approval_snapshots (
  id               TEXT PRIMARY KEY,
  product_id       TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  revision_id      TEXT REFERENCES product_revisions(id) ON DELETE SET NULL,
  draft_version    INTEGER NOT NULL,
  listing_run_id   TEXT NOT NULL,
  pricing_run_id   TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  ordered_final_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_platform  TEXT NOT NULL DEFAULT '1688',
  source_canonical_url TEXT NOT NULL,
  source_item_id   TEXT NOT NULL,
  canonical_success_detail_id TEXT NOT NULL,
  locale           TEXT NOT NULL,
  currency         TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL,
  attributes       JSONB NOT NULL DEFAULT '[]'::jsonb,
  item_number      TEXT,
  price_minor      TEXT NOT NULL,
  price_currency   TEXT NOT NULL,
  stock            INTEGER NOT NULL,
  weight_kg        TEXT NOT NULL,
  dimensions       JSONB,
  skus             JSONB NOT NULL DEFAULT '[]'::jsonb,
  state            TEXT NOT NULL DEFAULT 'unapproved',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULLS NOT DISTINCT keeps idempotency real even when revision_id is NULL
  -- (ConfirmMiaoshouEditV1 currently doesn't carry a revisionId; Wave 2 wires mapping).
  CONSTRAINT approval_snapshots_unique_triplet UNIQUE NULLS NOT DISTINCT
    (product_id, revision_id, draft_version, listing_run_id, pricing_run_id)
);

CREATE TABLE IF NOT EXISTS miaoshou_syncs (
  id               TEXT PRIMARY KEY,
  approval_snapshot_id TEXT NOT NULL REFERENCES approval_snapshots(id) ON DELETE CASCADE,
  state            TEXT NOT NULL DEFAULT 'not_started',
  remote_detail_id TEXT,
  last_reconciled_at TIMESTAMPTZ,
  error            JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (approval_snapshot_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  business_key     TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  payload          JSONB NOT NULL,
  batch_key        TEXT,
  pause_reason     TEXT,
  status           TEXT NOT NULL DEFAULT 'queued',
  attempt          INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  next_attempt_at  TIMESTAMPTZ,
  owner            TEXT,
  lease_token      TEXT,
  lease_expires_at TIMESTAMPTZ,
  last_heartbeat_at TIMESTAMPTZ,
  remote_task_id   TEXT,
  error            JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, business_key)
);

-- Forward-compatible for local Wave 1 databases that already created the table.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_token TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS batch_key TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pause_reason TEXT;

CREATE TABLE IF NOT EXISTS worker_instances (
  id               TEXT PRIMARY KEY,
  label            TEXT NOT NULL,
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id               TEXT PRIMARY KEY,
  actor_type       TEXT NOT NULL,
  actor_id         TEXT,
  action           TEXT NOT NULL,
  target_kind      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  redacted         BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS templates (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  category_rules   JSONB NOT NULL DEFAULT '[]'::jsonb,
  reference_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  prompt_fragment  TEXT NOT NULL DEFAULT '',
  target_locale    TEXT NOT NULL,
  visual_style     TEXT NOT NULL DEFAULT '',
  enabled          BOOLEAN NOT NULL DEFAULT true,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  id                       INTEGER PRIMARY KEY,
  default_locale           TEXT NOT NULL DEFAULT 'th-TH',
  default_currency         TEXT NOT NULL DEFAULT 'THB',
  external_adapter_mode    TEXT NOT NULL DEFAULT 'mock',
  miaoshou_configured      BOOLEAN NOT NULL DEFAULT false,
  canvas_configured        BOOLEAN NOT NULL DEFAULT false,
  llm_configured           BOOLEAN NOT NULL DEFAULT false,
  exchange_rate_configured BOOLEAN NOT NULL DEFAULT false,
  worker_concurrency       INTEGER NOT NULL DEFAULT 1,
  max_canvas_runs_per_day  INTEGER NOT NULL DEFAULT 50,
  asset_root               TEXT NOT NULL DEFAULT './var/assets'
);
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS worker_paused BOOLEAN NOT NULL DEFAULT false;
`;
