import net from 'node:net';
import { readJson, getClientIp } from '../util/http.js';
import { randomId } from '../util/crypto.js';
import { createApiKey, listApiKeys, parseApiKey } from '../services/keys.js';
import { writeAudit } from '../services/audit.js';
import { badInput, notFound, requireNumber, requireString, ensureStringArray } from '../admin/helpers.js';
import { getModel } from '../services/models.js';
import { GatewayError } from '../util/errors.js';

function userSession(app, req) {
  const session = app.auth.requireUser(req);
  session._ip = getClientIp(req, app.config.trustProxy);
  return session;
}

function parsePortalTime(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const str = String(value);
  if (/^\d+$/.test(str)) return Number(str);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  const ts = Date.parse(str);
  if (!Number.isFinite(ts)) throw badInput('Invalid date');
  return ts;
}

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function startOfDaysAgo(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - (Math.max(1, days) - 1) * 86400000;
}

function fillDaily(rows, days, start) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const items = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start + i * 86400000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    items.push(byDay.get(key) || { day: key, requests: 0, tokens: 0, cost: 0 });
  }
  return items;
}

function portalQuotas(app, session) {
  const ctx = { user: session.user, key: null, quotaOrg: session.org };
  const scopes = app.quota.scopesFor(ctx);
  return scopes.filter((s) => s.type !== 'key').map((s) => ({
    type: s.type,
    id: s.id,
    label: s.label,
    limit: s.limit,
    spent: app.quota.getSpent(s.type, s.id),
    reserved: app.quota.reservedFor(s.type, s.id),
    period: app.quota.periodKey(),
  }));
}

function ownKey(app, session, keyId) {
  const key = parseApiKey(app.db.get('SELECT * FROM api_keys WHERE id = ?', keyId));
  if (!key || key.user_id !== session.user.id) throw notFound('API key not found');
  return key;
}

function validatePortalKeyBody(app, body, { create }) {
  const out = {};
  if (create || body.name !== undefined) out.name = requireString(body.name, 'Key 名称', { max: 100 });
  if (body.expires_at !== undefined) {
    if (body.expires_at === null || body.expires_at === '') out.expires_at = null;
    else {
      const ts = Number(body.expires_at);
      if (!Number.isFinite(ts) || ts < Date.now()) throw badInput('过期时间必须晚于当前时间');
      out.expires_at = ts;
    }
  }
  if (body.monthly_limit_usd !== undefined) out.monthly_limit_usd = requireNumber(body.monthly_limit_usd, '月度限额', { min: 0, max: 100000000 });
  if (body.total_limit_usd !== undefined) out.total_limit_usd = requireNumber(body.total_limit_usd, '总额度', { min: 0, max: 100000000 });
  if (body.qps_limit !== undefined) out.qps_limit = body.qps_limit === null || body.qps_limit === '' ? null : requireNumber(body.qps_limit, 'QPS 限制', { min: 1, max: 100000, integer: true });
  if (body.tpm_limit !== undefined) out.tpm_limit = body.tpm_limit === null || body.tpm_limit === '' ? null : requireNumber(body.tpm_limit, 'TPM 限制', { min: 1, max: 100000000, integer: true });
  if (body.allowed_models !== undefined) {
    if (body.allowed_models === null || (Array.isArray(body.allowed_models) && body.allowed_models.length === 0)) out.allowed_models = null;
    else {
      const models = ensureStringArray(body.allowed_models, 'allowed_models', { max: 100 });
      for (const alias of models) {
        if (!app.db.get('SELECT alias FROM models WHERE alias = ? AND visible = 1', alias)) throw badInput(`Model '${alias}' is not available`);
      }
      out.allowed_models = models;
    }
  }
  if (body.ip_whitelist !== undefined) {
    if (body.ip_whitelist === null || (Array.isArray(body.ip_whitelist) && body.ip_whitelist.length === 0)) out.ip_whitelist = null;
    else {
      const list = ensureStringArray(body.ip_whitelist, 'ip_whitelist', { max: 50 });
      for (const raw of list) {
        const [ip, bits] = raw.split('/');
        if (!net.isIP(ip)) throw badInput(`Invalid IP or CIDR: ${raw}`);
        if (bits !== undefined) {
          const n = Number(bits);
          if (!Number.isInteger(n) || n < 0 || n > (net.isIP(ip) === 4 ? 32 : 128)) throw badInput(`Invalid CIDR: ${raw}`);
        }
      }
      out.ip_whitelist = list;
    }
  }
  return out;
}

export function registerPortalRoutes(router, app) {
  const { db, engine, logStore, quota, settings } = app;

  router.get('/api/portal/overview', (req, res) => {
    const session = userSession(app, req);
    const user = session.user;
    logStore.flushSync();
    const now = Date.now();
    const mStart = monthStart();
    const month = db.get(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM request_logs WHERE user_id = ? AND ts >= ?`,
      user.id, mStart,
    );
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStats = db.get(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS cost_usd, COALESCE(SUM(total_tokens),0) AS tokens
       FROM request_logs WHERE user_id = ? AND ts >= ?`,
      user.id, today.getTime(),
    );
    const days = 30;
    const dailyStart = startOfDaysAgo(days);
    const daily = fillDaily(db.all(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
       FROM request_logs WHERE user_id = ? AND ts >= ?
       GROUP BY day ORDER BY day`,
      user.id, dailyStart,
    ), days, dailyStart);
    const keys = db.get("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND status = 'active'", user.id).c;
    const recent = db.all(
      `SELECT id, ts, model, status, http_status, latency_ms, ttft_ms, total_tokens, cost_usd, source
       FROM request_logs WHERE user_id = ? ORDER BY ts DESC LIMIT 6`,
      user.id,
    );
    res.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, org_name: session.org.name },
      quota: { scopes: portalQuotas(app, session), period: quota.periodKey() },
      month,
      today: todayStats,
      daily,
      active_keys: keys,
      recent_requests: recent,
      platform: {
        name: settings.get('platform.name', 'LLM Gateway'),
        base_url: `${app.config.publicBaseUrl}/v1`,
        currency: settings.get('platform.currency', 'CNY'),
        currency_rate: settings.getNumber('platform.currency_rate', 7.2),
        markup_ratio: settings.getNumber('platform.markup_ratio', 1),
      },
    });
  });

  router.get('/api/portal/keys', (req, res) => {
    const session = userSession(app, req);
    const result = listApiKeys(db, { userId: session.user.id, page_size: 200 });
    res.json(result);
  });

  router.post('/api/portal/keys', async (req, res) => {
    const session = userSession(app, req);
    const user = session.user;
    const activeCount = db.get("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND status = 'active'", user.id).c;
    if (activeCount >= 50) throw badInput('已达到单用户 50 个活跃 Key 的上限，请先停用不再使用的 Key');
    const body = await readJson(req, 256 * 1024);
    const limits = validatePortalKeyBody(app, body, { create: true });
    const { plaintext, record } = createApiKey(db, app.config.masterSecret, {
      user,
      name: limits.name,
      expiresAt: limits.expires_at ?? null,
      monthlyLimitUsd: limits.monthly_limit_usd ?? 0,
      totalLimitUsd: limits.total_limit_usd ?? 0,
      qpsLimit: limits.qps_limit ?? null,
      tpmLimit: limits.tpm_limit ?? null,
      allowedModels: limits.allowed_models ?? null,
      ipWhitelist: limits.ip_whitelist ?? null,
      tags: ['DEV'],
    });
    writeAudit(db, {
      actor: user, action: 'key.created', targetType: 'key', targetId: record.id,
      detail: { name: record.name, monthly_limit_usd: record.monthly_limit_usd }, ip: session._ip,
    });
    res.status(201).json({ key: record, plaintext });
  });

  router.patch('/api/portal/keys/:id', async (req, res) => {
    const session = userSession(app, req);
    const key = ownKey(app, session, req.params.id);
    const body = await readJson(req, 64 * 1024);
    const fields = [];
    const params = [];
    if (body.name !== undefined) {
      fields.push('name = ?');
      params.push(requireString(body.name, 'Key 名称', { max: 100 }));
    }
    if (body.status !== undefined) {
      if (!['active', 'disabled'].includes(body.status)) throw badInput('仅支持启用或停用 Key');
      if (key.status === 'revoked') throw badInput('已吊销的 Key 无法重新启用');
      fields.push('status = ?');
      params.push(body.status);
    }
    if (!fields.length) throw badInput('No fields to update');
    params.push(Date.now(), key.id);
    db.run(`UPDATE api_keys SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`, ...params);
    app.keyAuth.invalidate(key.id);
    writeAudit(db, { actor: session.user, action: 'key.updated', targetType: 'key', targetId: key.id, detail: { fields: Object.keys(body) }, ip: session._ip });
    res.json({ key: parseApiKey(db.get('SELECT * FROM api_keys WHERE id = ?', key.id)) });
  });

  router.delete('/api/portal/keys/:id', (req, res) => {
    const session = userSession(app, req);
    const key = ownKey(app, session, req.params.id);
    db.run("UPDATE api_keys SET status = 'revoked', updated_at = ? WHERE id = ?", Date.now(), key.id);
    app.keyAuth.invalidate(key.id);
    writeAudit(db, { actor: session.user, action: 'key.revoked', targetType: 'key', targetId: key.id, detail: { name: key.name }, ip: session._ip });
    res.json({ ok: true });
  });

  router.get('/api/portal/models', (req, res) => {
    userSession(app, req);
    const models = engine.listModelsForContext({ key: { allowed_models: null } });
    res.json(models);
  });

  router.get('/api/portal/logs', (req, res) => {
    const session = userSession(app, req);
    const url = new URL(req.url, 'http://localhost');
    const result = logStore.query({
      user_id: session.user.id,
      from: parsePortalTime(url.searchParams.get('from'), 0),
      to: parsePortalTime(url.searchParams.get('to'), Date.now() + 1),
      status: url.searchParams.get('status') || undefined,
      model: url.searchParams.get('model') || undefined,
      request_id: url.searchParams.get('request_id') || undefined,
      page: url.searchParams.get('page'),
      page_size: url.searchParams.get('page_size'),
    });
    res.json(result);
  });

  router.get('/api/portal/usage', (req, res) => {
    const session = userSession(app, req);
    const url = new URL(req.url, 'http://localhost');
    const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));
    const from = startOfDaysAgo(days);
    logStore.flushSync();
    const daily = fillDaily(db.all(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
       FROM request_logs WHERE user_id = ? AND ts >= ? GROUP BY day ORDER BY day`,
      session.user.id, from,
    ), days, from);
    const byModel = db.all(
      `SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
       FROM request_logs WHERE user_id = ? AND ts >= ? GROUP BY model ORDER BY cost DESC LIMIT 20`,
      session.user.id, from,
    );
    const totals = db.get(
      `SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd
       FROM request_logs WHERE user_id = ? AND ts >= ?`,
      session.user.id, from,
    );
    res.json({ days, daily, by_model: byModel, totals, quota: portalQuotas(app, session) });
  });

  router.post('/api/portal/playground', async (req, res) => {
    const session = userSession(app, req);
    const body = await readJson(req, settings.getNumber('limits.max_body_mb', 32) * 1024 * 1024);
    if (!body || typeof body.model !== 'string') throw badInput('model is required');
    const model = getModel(db, body.model);
    if (!model || !model.visible) throw notFound('Model not found');
    if (model.kind !== 'router' && !model.capabilities.includes('chat')) throw badInput('This model does not support chat');
    if (!Array.isArray(body.messages) || !body.messages.length) throw badInput('messages is required');
    if (body.max_tokens !== undefined) {
      const n = Number(body.max_tokens);
      if (!Number.isFinite(n) || n < 1 || n > 32768) throw badInput('max_tokens must be between 1 and 32768');
      body.max_tokens = Math.floor(n);
    }
    body.stream = body.stream !== false;
    const ctx = app.keyAuth.playgroundContext(session.user, session.org, session._ip);
    const requestId = randomId('req_');
    res.setHeader('X-Request-Id', requestId);
    await engine.execute(req, res, { endpoint: 'chat', body, ctx, requestId });
  });

  router.post('/api/portal/password', async (req, res) => {
    const session = userSession(app, req);
    const body = await readJson(req, 64 * 1024);
    const next = String(body.new_password || '');
    if (next.length < 8) throw badInput('新密码至少需要 8 位');
    await app.auth.changePassword(session.user.id, body.old_password, next);
    writeAudit(db, { actor: session.user, action: 'auth.password.changed', targetType: 'user', targetId: session.user.id, ip: session._ip });
    res.json({ ok: true });
  });

  router.get('/api/portal/config', (req, res) => {
    userSession(app, req);
    res.json({
      base_url: `${app.config.publicBaseUrl}/v1`,
      platform: {
        name: settings.get('platform.name', 'LLM Gateway'),
        currency: settings.get('platform.currency', 'CNY'),
        currency_rate: settings.getNumber('platform.currency_rate', 7.2),
      },
    });
  });
}
