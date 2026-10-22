PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS orgs (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  parent_id         TEXT,
  path              TEXT NOT NULL,
  monthly_quota_usd REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orgs_parent ON orgs(parent_id);

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  employee_no       TEXT,
  role              TEXT NOT NULL DEFAULT 'APP_USER',
  org_id            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  password_hash     TEXT,
  auth_source       TEXT NOT NULL DEFAULT 'local',
  sso_provider      TEXT,
  sso_sub           TEXT,
  monthly_quota_usd REAL NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_login_at     INTEGER,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso ON users(sso_provider, sso_sub) WHERE sso_provider IS NOT NULL AND sso_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS api_keys (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  org_id            TEXT NOT NULL,
  name              TEXT NOT NULL,
  key_hash          TEXT NOT NULL,
  lookup_hash       TEXT NOT NULL UNIQUE,
  masked            TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  expires_at        INTEGER,
  monthly_limit_usd REAL NOT NULL DEFAULT 0,
  total_limit_usd   REAL NOT NULL DEFAULT 0,
  qps_limit         INTEGER,
  tpm_limit         INTEGER,
  allowed_models    TEXT,
  ip_whitelist      TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  last_used_at      INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_keys_org ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_keys_status ON api_keys(status);

CREATE TABLE IF NOT EXISTS channels (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  provider              TEXT NOT NULL,
  base_url              TEXT NOT NULL,
  api_version           TEXT,
  priority              INTEGER NOT NULL DEFAULT 5,
  weight                INTEGER NOT NULL DEFAULT 10,
  timeout_ms            INTEGER NOT NULL DEFAULT 60000,
  first_byte_timeout_ms INTEGER NOT NULL DEFAULT 30000,
  concurrency_limit     INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'enabled',
  headers               TEXT NOT NULL DEFAULT '{}',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_status ON channels(status);

CREATE TABLE IF NOT EXISTS channel_keys (
  id            TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  hint          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  weight        INTEGER NOT NULL DEFAULT 10,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_channel_keys_channel ON channel_keys(channel_id);

CREATE TABLE IF NOT EXISTS channel_models (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id     TEXT NOT NULL,
  model_alias    TEXT NOT NULL,
  upstream_model TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  UNIQUE(channel_id, model_alias),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_channel_models_alias ON channel_models(model_alias, enabled);

CREATE TABLE IF NOT EXISTS models (
  alias             TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  context_window    INTEGER NOT NULL DEFAULT 0,
  max_output_tokens INTEGER NOT NULL DEFAULT 0,
  input_price       REAL NOT NULL DEFAULT 0,
  output_price      REAL NOT NULL DEFAULT 0,
  capabilities      TEXT NOT NULL DEFAULT '[]',
  visible           INTEGER NOT NULL DEFAULT 1,
  fallback_chain    TEXT NOT NULL DEFAULT '[]',
  kind              TEXT NOT NULL DEFAULT 'model',
  smart_group       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_logs (
  id                TEXT PRIMARY KEY,
  ts                INTEGER NOT NULL,
  user_id           TEXT,
  org_id            TEXT,
  key_id            TEXT,
  source            TEXT NOT NULL DEFAULT 'api',
  endpoint          TEXT NOT NULL,
  model             TEXT NOT NULL,
  upstream_model    TEXT,
  channel_id        TEXT,
  provider          TEXT,
  stream            INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  http_status       INTEGER NOT NULL,
  latency_ms        INTEGER NOT NULL DEFAULT 0,
  ttft_ms           INTEGER,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  estimated         INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  error_type        TEXT,
  error_code        TEXT,
  error_message     TEXT,
  attempts          INTEGER NOT NULL DEFAULT 1,
  client_ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_user ON request_logs(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_org ON request_logs(org_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_key ON request_logs(key_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_status ON request_logs(status, ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_channel ON request_logs(channel_id, ts DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  actor_id    TEXT,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id           TEXT PRIMARY KEY,
  ts           INTEGER NOT NULL,
  type         TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'warning',
  message      TEXT NOT NULL,
  detail       TEXT,
  delivered    INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts DESC);

CREATE TABLE IF NOT EXISTS alert_state (
  key      TEXT PRIMARY KEY,
  fired_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
