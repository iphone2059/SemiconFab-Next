-- SemiconFab Next: PostgreSQL 18+ design seed, not a production migration set.
-- Unqualified names map to engineering/13 schema names; do not create both sets.
-- Deliberately omits complete grants/RLS, frozen-version guards and fenced commit APIs.
-- Run in an empty, disposable database/schema with a controlled search_path.

BEGIN;

CREATE TABLE sites (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fab_template_versions (
  id uuid PRIMARY KEY,
  template_code text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  definition jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_code, version)
);

CREATE TABLE fab_units (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id),
  code text NOT NULL,
  fab_template_version_id uuid NOT NULL REFERENCES fab_template_versions(id),
  lifecycle text NOT NULL DEFAULT 'ACTIVE'
    CHECK (lifecycle IN ('ACTIVE','MAINTENANCE','RETIRED')),
  UNIQUE (site_id, id),
  UNIQUE (site_id, code)
);

CREATE TABLE equipment_instances (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL,
  fab_id uuid NOT NULL,
  local_code text NOT NULL,
  model_reference text NOT NULL,
  UNIQUE (site_id, fab_id, id),
  UNIQUE (site_id, fab_id, local_code),
  FOREIGN KEY (site_id, fab_id) REFERENCES fab_units(site_id, id)
);

CREATE TABLE scenario_versions (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id),
  scenario_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  -- COUPLED_FLOW is reserved, not an enabled v1 mode.
  mode text NOT NULL CHECK (mode IN ('INDEPENDENT','SHARED_CAPACITY')),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  frozen_config jsonb NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, id),
  UNIQUE (site_id, id, mode),
  UNIQUE (site_id, scenario_key, version)
);

CREATE TABLE scenario_fab_bindings (
  site_id uuid NOT NULL,
  scenario_id uuid NOT NULL, -- References a ScenarioVersion, never a mutable draft.
  fab_id uuid NOT NULL,
  template_version_id uuid NOT NULL REFERENCES fab_template_versions(id),
  PRIMARY KEY (scenario_id, fab_id),
  UNIQUE (site_id, scenario_id, fab_id, template_version_id),
  FOREIGN KEY (site_id, scenario_id) REFERENCES scenario_versions(site_id, id),
  FOREIGN KEY (site_id, fab_id) REFERENCES fab_units(site_id, id)
);

CREATE TABLE simulation_runs (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL,
  scenario_id uuid NOT NULL,
  mode text NOT NULL,
  engine_build text NOT NULL,
  run_seed numeric(20,0) NOT NULL
    CHECK (run_seed BETWEEN 0 AND 18446744073709551615),
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','CLAIMED','RUNNING','PAUSED','STOPPING','COMPLETED','FAILED','CANCELLED')),
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, id),
  UNIQUE (site_id, id, scenario_id),
  UNIQUE (site_id, id, mode),
  FOREIGN KEY (site_id, scenario_id, mode) REFERENCES scenario_versions(site_id, id, mode)
);

CREATE TABLE simulation_run_fabs (
  site_id uuid NOT NULL,
  run_id uuid NOT NULL,
  scenario_id uuid NOT NULL,
  fab_id uuid NOT NULL,
  template_version_id uuid NOT NULL,
  output_prefix text NOT NULL,
  PRIMARY KEY (run_id, fab_id),
  UNIQUE (site_id, run_id, fab_id),
  FOREIGN KEY (site_id, run_id, scenario_id)
    REFERENCES simulation_runs(site_id, id, scenario_id),
  FOREIGN KEY (site_id, scenario_id, fab_id, template_version_id)
    REFERENCES scenario_fab_bindings(site_id, scenario_id, fab_id, template_version_id)
);

-- Independent: one execution/lease per Run+FAB. Shared: one per Site Run.
-- Creation service must atomically create the complete expected execution/member set.
CREATE TABLE simulation_run_executions (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL,
  run_id uuid NOT NULL,
  fab_id uuid,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED','CLAIMED','RUNNING','PAUSED','STOPPING','COMPLETED','FAILED','CANCELLED')),
  phase text,
  state_version bigint NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  lease_owner text,
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_until_utc timestamptz,
  heartbeat_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'INDEPENDENT' AND fab_id IS NOT NULL)
      OR (mode = 'SHARED_CAPACITY' AND fab_id IS NULL)),
  CHECK ((lease_owner IS NULL) = (lease_until_utc IS NULL)),
  CHECK (lease_owner IS NULL OR lease_epoch > 0),
  UNIQUE (site_id, run_id, id),
  FOREIGN KEY (site_id, run_id, mode) REFERENCES simulation_runs(site_id, id, mode),
  -- MATCH SIMPLE intentionally skips only the Site-owned shared execution.
  FOREIGN KEY (site_id, run_id, fab_id)
    REFERENCES simulation_run_fabs(site_id, run_id, fab_id)
);
CREATE UNIQUE INDEX uq_execution_fab ON simulation_run_executions(run_id, fab_id)
  WHERE fab_id IS NOT NULL;
CREATE UNIQUE INDEX uq_execution_shared ON simulation_run_executions(run_id)
  WHERE fab_id IS NULL;

CREATE TABLE site_resources (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id),
  resource_kind text NOT NULL,
  -- All deterministic arbitration uses integer base units, never floating-point.
  capacity_in_base_unit bigint NOT NULL CHECK (capacity_in_base_unit >= 0),
  unit text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE (site_id, id)
);

CREATE TABLE resource_entitlements (
  site_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  fab_id uuid NOT NULL,
  max_share_in_base_unit bigint CHECK (max_share_in_base_unit >= 0),
  priority integer NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_id, fab_id),
  FOREIGN KEY (site_id, resource_id) REFERENCES site_resources(site_id, id),
  FOREIGN KEY (site_id, fab_id) REFERENCES fab_units(site_id, id)
);

CREATE TABLE run_artifacts (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL,
  run_id uuid NOT NULL,
  fab_id uuid,
  execution_id uuid,
  lease_epoch bigint,
  artifact_kind text NOT NULL,
  uri text NOT NULL,
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-fA-F]{64}$'),
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((execution_id IS NULL AND lease_epoch IS NULL)
      OR (execution_id IS NOT NULL AND lease_epoch IS NOT NULL AND lease_epoch > 0)),
  CHECK (artifact_kind NOT IN ('CHECKPOINT','EVENT_LOG') OR execution_id IS NOT NULL),
  FOREIGN KEY (site_id, run_id) REFERENCES simulation_runs(site_id, id),
  FOREIGN KEY (site_id, run_id, fab_id)
    REFERENCES simulation_run_fabs(site_id, run_id, fab_id),
  FOREIGN KEY (site_id, run_id, execution_id)
    REFERENCES simulation_run_executions(site_id, run_id, id),
  UNIQUE (run_id, artifact_kind, uri)
);
-- FK cannot prove a lease is current or bind an Independent execution's FAB.
-- Worker commit transaction MUST lock execution, validate scope/owner/current epoch/
-- nonexpired lease and INSERT catalog+CAS status atomically; direct Worker writes denied.
-- CHECKPOINT/EVENT_LOG kinds require execution_id+epoch; root manifest is Orchestration-owned.

CREATE TABLE idempotency_requests (
  site_id uuid NOT NULL REFERENCES sites(id),
  principal_id text NOT NULL,
  operation text NOT NULL, -- Includes method and target resource.
  key text NOT NULL,
  request_hash char(64) NOT NULL CHECK (request_hash ~ '^[0-9a-fA-F]{64}$'),
  response_status integer NOT NULL CHECK (response_status BETWEEN 200 AND 599),
  response_body jsonb, -- May be purged after expiry; key/hash/original run tombstone remains.
  response_location text,
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (site_id, principal_id, operation, key),
  CHECK (expires_at > created_at),
  FOREIGN KEY (site_id, run_id) REFERENCES simulation_runs(site_id, id)
);

CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY UNIQUE, -- Scan key, not commit/business order.
  event_id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES sites(id),
  aggregate_key text NOT NULL,
  aggregate_sequence bigint NOT NULL CHECK (aggregate_sequence > 0),
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (site_id, aggregate_key, aggregate_sequence)
);

CREATE TABLE inbox_dedup (
  site_id uuid NOT NULL REFERENCES sites(id),
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, consumer, event_id)
);

CREATE INDEX idx_fab_units_site ON fab_units(site_id);
CREATE INDEX idx_equipment_fab ON equipment_instances(site_id, fab_id);
CREATE INDEX idx_runs_status ON simulation_runs(status, created_at);
CREATE INDEX idx_executions_claim ON simulation_run_executions(status, created_at);
CREATE INDEX idx_executions_lease ON simulation_run_executions(lease_until_utc)
  WHERE lease_owner IS NOT NULL;
CREATE INDEX idx_artifacts_run ON run_artifacts(site_id, run_id);
CREATE INDEX idx_outbox_unpublished ON outbox_events(id) WHERE published_at IS NULL;
-- Publish by unpublished rows and mark each after confirmation. A global id>cursor
-- watermark can skip lower IDs committed later; identity allocation is not commit order.

-- FAB-scoped, fail-closed example: missing/empty settings yield NULL, never TRUE.
-- Malformed UUID settings fail the query; they do not broaden access.
-- Runtime role must be nonowner, NOSUPERUSER, NOBYPASSRLS, without TRUNCATE/DDL.
-- Custom settings are NOT authentication: only the trusted app maps verified grants.
-- No runtime GRANT is included; complete all other table policies before deployment.
ALTER TABLE equipment_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment_instances FORCE ROW LEVEL SECURITY;
CREATE POLICY equipment_fab_scope ON equipment_instances
  USING (
    site_id = nullif(current_setting('app.site_id', true), '')::uuid
    AND fab_id = nullif(current_setting('app.fab_id', true), '')::uuid
  )
  WITH CHECK (
    site_id = nullif(current_setting('app.site_id', true), '')::uuid
    AND fab_id = nullif(current_setting('app.fab_id', true), '')::uuid
  );

COMMIT;

-- Transaction-scoped example: use verified values, never raw caller scope.
-- BEGIN;
-- SELECT set_config('app.site_id', @authorized_site_id, true);
-- SELECT set_config('app.fab_id', @authorized_fab_id, true);
-- SELECT * FROM equipment_instances;
-- COMMIT;
-- Never set SESSION defaults for tenants on pooled connections.
