import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const rootDir = path.resolve(import.meta.dirname, '..');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(rootDir, '.env'));

const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

function resolveMasterSecret() {
  if (process.env.MASTER_SECRET && process.env.MASTER_SECRET.length >= 16) {
    return process.env.MASTER_SECRET;
  }
  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

export const config = {
  rootDir,
  dataDir,
  dbPath: path.resolve(dataDir, 'gateway.db'),
  webDir: path.join(rootDir, 'src', 'web'),
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 8080),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${int(process.env.PORT, 8080)}`).replace(/\/$/, ''),
  masterSecret: resolveMasterSecret(),
  bootstrap: {
    email: process.env.BOOTSTRAP_ADMIN_EMAIL || 'admin@corp.local',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Admin@12345',
    name: process.env.BOOTSTRAP_ADMIN_NAME || '平台管理员',
  },
  maxConcurrentRequests: int(process.env.MAX_CONCURRENT_REQUESTS, 5000),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  logLevel: process.env.LOG_LEVEL || 'info',
  demoMode: bool(process.env.DEMO_MODE, false),
  metricsAuth: process.env.METRICS_USER
    ? { user: process.env.METRICS_USER, password: process.env.METRICS_PASSWORD || '' }
    : null,
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  sessionTtlSec: 12 * 3600,
  cookieName: 'gw_session',
  version: '1.0.0',
};
