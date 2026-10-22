import { readJson } from '../util/http.js';
import { encryptSecret, decryptSecret } from '../util/crypto.js';
import { DEFAULT_SETTINGS } from '../db/index.js';
import {
  requireAdmin, SUPER_ONLY, badInput, requireNumber, auditAs,
} from './helpers.js';

const TYPE_RULES = {
  'platform.markup_ratio': { min: 0.1, max: 10 },
  'platform.currency_rate': { min: 0.01, max: 100 },
  'limits.default_qps': { min: 1, max: 100000, integer: true },
  'limits.default_tpm': { min: 1, max: 1000000000, integer: true },
  'limits.max_body_mb': { min: 1, max: 100, integer: true },
  'limits.max_attempts': { min: 1, max: 5, integer: true },
  'limits.min_completion_reserve': { min: 1, max: 100000, integer: true },
  'quota.soft_ratio': { min: 0.1, max: 1 },
  'quota.overdraft_prod_ratio': { min: 0, max: 2 },
  'circuit.failure_threshold': { min: 1, max: 100, integer: true },
  'circuit.window_size': { min: 4, max: 500, integer: true },
  'circuit.error_rate': { min: 0.01, max: 1 },
  'circuit.cooldown_ms': { min: 1000, max: 600000, integer: true },
  'health.interval_ms': { min: 5000, max: 600000, integer: true },
  'sse.heartbeat_ms': { min: 0, max: 120000, integer: true },
  'logs.retention_days': { min: 1, max: 3650, integer: true },
  'security.session_ttl_hours': { min: 1, max: 720, integer: true },
};

const BOOL_KEYS = new Set([
  'security.local_login_enabled', 'sso.auto_create',
]);

const STRING_ENUMS = {
  'platform.currency': ['USD', 'CNY'],
  'alert.webhook_type': ['feishu', 'wecom', 'generic'],
  'sso.default_role': ['APP_USER', 'ORG_ADMIN', 'AUDITOR'],
  'routing.order_strategy': ['weighted', 'latency'],
};

const JSON_KEYS = new Set(['smart_routes', 'sso.providers']);
const SECRET_KEYS = new Set(['sso.providers']);

const SSO_TYPES = ['oidc', 'oauth2', 'feishu', 'dingtalk'];

function normalizeSsoProviders(value) {
  if (!Array.isArray(value)) throw badInput('sso.providers must be an array');
  const ids = new Set();
  return value.map((p) => {
    if (!p || typeof p !== 'object') throw badInput('Each SSO provider must be an object');
    if (!p.id || !/^[a-zA-Z0-9_-]{1,50}$/.test(p.id)) throw badInput('SSO provider id is invalid');
    if (ids.has(p.id)) throw badInput(`Duplicate SSO provider id: ${p.id}`);
    ids.add(p.id);
    if (!SSO_TYPES.includes(p.type)) throw badInput(`Invalid SSO provider type: ${p.type}`);
    if (!p.name) throw badInput('SSO provider name is required');
    return {
      ...p,
      enabled: !!p.enabled,
      client_id: p.client_id || '',
      client_secret: p.client_secret || '',
      redirect_path: p.redirect_path || `/auth/sso/${p.id}/callback`,
    };
  });
}

function validateSetting(key, value) {
  if (TYPE_RULES[key]) {
    const rule = TYPE_RULES[key];
    const n = requireNumber(value, key, rule);
    return String(n);
  }
  if (BOOL_KEYS.has(key)) {
    if (!['true', 'false'].includes(String(value))) throw badInput(`${key} must be true or false`);
    return String(value);
  }
  if (STRING_ENUMS[key]) {
    if (!STRING_ENUMS[key].includes(String(value))) throw badInput(`${key} must be one of ${STRING_ENUMS[key].join(', ')}`);
    return String(value);
  }
  if (JSON_KEYS.has(key)) {
    let parsed;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value); } catch { throw badInput(`${key} must be valid JSON`); }
    } else parsed = value;
    if (key === 'sso.providers') parsed = normalizeSsoProviders(parsed);
    if (key === 'smart_routes') {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badInput('smart_routes must be an object');
      if (parsed.groups && typeof parsed.groups !== 'object') throw badInput('smart_routes.groups must be an object');
    }
    return JSON.stringify(parsed);
  }
  if (key === 'alert.webhook_url') {
    const url = String(value || '').trim();
    if (url) {
      try {
        const u = new URL(url);
        if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      } catch { throw badInput('Webhook URL must be a valid http(s) URL'); }
    }
    return url;
  }
  if (key === 'platform.name') {
    const s = String(value || '').trim();
    if (!s || s.length > 100) throw badInput('Platform name is invalid');
    return s;
  }
  return String(value);
}

export function registerSettingsRoutes(router, app) {
  const { settings } = app;

  router.get('/api/admin/settings', (req, res) => {
    requireAdmin(app, req, { roles: SUPER_ONLY });
    const values = settings.all();
    const providers = settings.getJSON('sso.providers', []).map((p) => {
      let clientSecret = p.client_secret || '';
      if (clientSecret.startsWith('enc:v1:')) {
        try { clientSecret = decryptSecret(app.config.masterSecret, clientSecret.slice(7)); } catch { clientSecret = ''; }
      }
      return {
        ...p,
        client_secret: clientSecret,
        callback_url: `${app.config.publicBaseUrl}${p.redirect_path || `/auth/sso/${p.id}/callback`}`,
      };
    });
    res.json({ values, sso_providers: providers, config: { public_base_url: app.config.publicBaseUrl } });
  });

  router.put('/api/admin/settings', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const body = await readJson(req, 1024 * 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badInput('Settings body must be an object');
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const updates = {};
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) throw badInput(`Unknown setting: ${key}`);
      if (key === 'sso.default_org_id') {
        const id = String(value || '');
        if (id && !app.db.get('SELECT id FROM orgs WHERE id = ?', id)) throw badInput('Default SSO organization not found');
        updates[key] = id;
        continue;
      }
      updates[key] = validateSetting(key, value);
    }
    if (!Object.keys(updates).length) throw badInput('No settings provided');
    if (updates['sso.providers']) {
      const providers = JSON.parse(updates['sso.providers']).map((p) => ({
        ...p,
        client_secret: p.client_secret
          ? (p.client_secret.startsWith('enc:v1:') ? p.client_secret : `enc:v1:${encryptSecret(app.config.masterSecret, p.client_secret)}`)
          : '',
      }));
      updates['sso.providers'] = JSON.stringify(providers);
    }
    settings.setMany(updates);
    auditAs(app, session, 'settings.updated', {
      targetType: 'settings',
      targetId: 'global',
      detail: { keys: Object.keys(updates).map((k) => (SECRET_KEYS.has(k) ? `${k} (redacted)` : k)) },
    });
    res.json({ values: settings.all() });
  });
}
