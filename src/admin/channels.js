import { randomId, encryptSecret } from '../util/crypto.js';
import { readJson } from '../util/http.js';
import { PROVIDER_IDS } from '../providers/index.js';
import { listChannels, getChannel, listChannelKeys, getChannelModels } from '../services/channels.js';
import { parseModel } from '../services/models.js';
import {
  requireAdmin, SUPER_ONLY, badInput, notFound, conflict, requireString, requireNumber,
  optionalBoolean, ensureObject, auditAs,
} from './helpers.js';

function normalizeModels(app, value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badInput('models must be an array');
  const seen = new Set();
  return value.map((m) => {
    if (!m || typeof m !== 'object') throw badInput('Each model mapping must be an object');
    const alias = requireString(m.alias, '模型别名', { max: 100 });
    if (!app.db.get('SELECT alias FROM models WHERE alias = ?', alias)) throw badInput(`Model '${alias}' does not exist in the model catalog`);
    if (seen.has(alias)) throw badInput(`Duplicate model mapping: ${alias}`);
    seen.add(alias);
    return {
      alias,
      upstream_model: requireString(m.upstream_model, '上游模型标识', { max: 200 }),
      enabled: m.enabled === undefined ? true : !!m.enabled,
    };
  });
}

function channelInput(app, body, { create }) {
  const out = {};
  if (create || body.name !== undefined) out.name = requireString(body.name, '渠道名称', { max: 100 });
  if (create || body.provider !== undefined) {
    out.provider = requireString(body.provider, '供应商类型', { max: 30 });
    if (!PROVIDER_IDS.includes(out.provider)) throw badInput(`Unsupported provider: ${out.provider}`);
  }
  if (create || body.base_url !== undefined) {
    out.base_url = requireString(body.base_url, 'Base URL', { max: 500 }).replace(/\/+$/, '');
    let url;
    try { url = new URL(out.base_url); } catch { throw badInput('Base URL is not a valid URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw badInput('Base URL must use http or https');
  }
  if (body.api_version !== undefined) out.api_version = body.api_version ? String(body.api_version).slice(0, 100) : null;
  if (body.priority !== undefined) out.priority = requireNumber(body.priority, '优先级', { min: 1, max: 10, integer: true });
  if (body.weight !== undefined) out.weight = requireNumber(body.weight, '权重', { min: 1, max: 100, integer: true });
  if (body.timeout_ms !== undefined) out.timeout_ms = requireNumber(body.timeout_ms, '超时时间', { min: 1000, max: 600000, integer: true });
  if (body.first_byte_timeout_ms !== undefined) out.first_byte_timeout_ms = requireNumber(body.first_byte_timeout_ms, '首字超时时间', { min: 1000, max: 300000, integer: true });
  if (body.concurrency_limit !== undefined) out.concurrency_limit = requireNumber(body.concurrency_limit, '并发上限', { min: 0, max: 100000, integer: true });
  if (body.headers !== undefined) {
    const headers = ensureObject(body.headers, 'headers') || {};
    out.headers = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(k)) throw badInput(`Invalid header name: ${k}`);
      if (typeof v !== 'string') throw badInput(`Header ${k} must be a string`);
      out.headers[k] = v.slice(0, 2000);
    }
  }
  if (body.models !== undefined) out.models = normalizeModels(app, body.models);
  return out;
}

function addChannelKeys(app, channelId, keys) {
  if (!Array.isArray(keys) || !keys.length) return 0;
  const existing = listChannelKeys(app.db, channelId, true, app.config.masterSecret).map((k) => k.key).filter(Boolean);
  let count = 0;
  const ts = Date.now();
  for (const raw of keys) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key) continue;
    if (key.length > 4096) throw badInput('上游 Key 过长');
    if (existing.includes(key)) continue;
    app.db.run(
      'INSERT INTO channel_keys (id, channel_id, encrypted_key, hint, status, weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomId('ck_'), channelId, encryptSecret(app.config.masterSecret, key), `...${key.slice(-4)}`, 'active', 10, ts,
    );
    existing.push(key);
    count++;
  }
  return count;
}

export function registerChannelRoutes(router, app) {
  const { db, settings, circuit, routing, health, engine } = app;

  router.get('/api/admin/channels', (req, res) => {
    const session = requireAdmin(app, req, { roles: ['SUPER_ADMIN', 'AUDITOR'] });
    const items = listChannels(db, app.circuits).map((c) => (
      session.user.role === 'SUPER_ADMIN' ? c : { ...c, headers: {} }
    ));
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const stats = new Map(db.all(
      `SELECT channel_id, COUNT(*) AS requests, SUM(cost_usd) AS cost, AVG(latency_ms) AS avg_latency,
              SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors
       FROM request_logs WHERE ts >= ? GROUP BY channel_id`,
      todayStart.getTime(),
    ).map((r) => [r.channel_id, r]));
    const enriched = items.map((c) => ({
      ...c,
      health: health.snapshot(c.id),
      slots: routing.activeSlots(c.id),
      usage_today: stats.get(c.id) || { requests: 0, cost: 0, avg_latency: null, errors: 0 },
    }));
    res.json({ items: enriched });
  });

  router.get('/api/admin/providers', (req, res) => {
    requireAdmin(app, req, { roles: ['SUPER_ADMIN', 'AUDITOR'] });
    res.json({ items: app.providersMeta });
  });

  router.post('/api/admin/channels', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const body = await readJson(req, 2 * 1024 * 1024);
    const input = channelInput(app, body, { create: true });
    const ts = Date.now();
    const id = randomId('chn_');
    db.transaction(() => {
      db.run(
        `INSERT INTO channels (id, name, provider, base_url, api_version, priority, weight, timeout_ms,
          first_byte_timeout_ms, concurrency_limit, status, headers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?, ?, ?)`,
        id, input.name, input.provider, input.base_url, input.api_version || null,
        input.priority ?? 5, input.weight ?? 10, input.timeout_ms ?? 60000, input.first_byte_timeout_ms ?? 30000,
        input.concurrency_limit ?? 0, JSON.stringify(input.headers || {}), ts, ts,
      );
      for (const m of input.models || []) {
        db.run('INSERT INTO channel_models (channel_id, model_alias, upstream_model, enabled, created_at) VALUES (?, ?, ?, ?, ?)',
          id, m.alias, m.upstream_model, m.enabled ? 1 : 0, ts);
      }
    });
    const added = addChannelKeys(app, id, body.keys);
    routing.invalidate();
    health.probe(id).catch(() => {});
    auditAs(app, session, 'channel.created', { targetType: 'channel', targetId: id, detail: { name: input.name, provider: input.provider, keys: added } });
    res.status(201).json({ channel: getChannel(db, id), keys_added: added });
  });

  router.put('/api/admin/channels/:id', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const channel = getChannel(db, req.params.id);
    if (!channel) throw notFound('Channel not found');
    const body = await readJson(req, 2 * 1024 * 1024);
    const input = channelInput(app, body, { create: false });
    const ts = Date.now();
    db.transaction(() => {
      const fields = [];
      const params = [];
      for (const [key, value] of Object.entries(input)) {
        if (key === 'models') continue;
        fields.push(`${key} = ?`);
        params.push(key === 'headers' ? JSON.stringify(value) : value);
      }
      if (fields.length) {
        params.push(ts, channel.id);
        db.run(`UPDATE channels SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`, ...params);
      }
      if (input.models) {
        db.run('DELETE FROM channel_models WHERE channel_id = ?', channel.id);
        for (const m of input.models) {
          db.run('INSERT INTO channel_models (channel_id, model_alias, upstream_model, enabled, created_at) VALUES (?, ?, ?, ?, ?)',
            channel.id, m.alias, m.upstream_model, m.enabled ? 1 : 0, ts);
        }
      }
    });
    if (body.keys !== undefined) addChannelKeys(app, channel.id, body.keys);
    routing.invalidate();
    health.probe(channel.id).catch(() => {});
    auditAs(app, session, 'channel.updated', { targetType: 'channel', targetId: channel.id, detail: { fields: Object.keys(input) } });
    res.json({ channel: getChannel(db, channel.id) });
  });

  router.delete('/api/admin/channels/:id', (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const channel = getChannel(db, req.params.id);
    if (!channel) throw notFound('Channel not found');
    db.run('DELETE FROM channels WHERE id = ?', channel.id);
    app.circuits.forget(channel.id);
    health.states.delete(channel.id);
    routing.invalidate();
    auditAs(app, session, 'channel.deleted', { targetType: 'channel', targetId: channel.id, detail: { name: channel.name } });
    res.json({ ok: true });
  });

  router.post('/api/admin/channels/:id/keys', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const channel = getChannel(db, req.params.id);
    if (!channel) throw notFound('Channel not found');
    const body = await readJson(req, 256 * 1024);
    const keys = Array.isArray(body.keys) ? body.keys : [body.key];
    const added = addChannelKeys(app, channel.id, keys);
    if (!added) throw conflict('No new keys were added (empty or duplicate)');
    routing.invalidateKeys(channel.id);
    auditAs(app, session, 'channel.keys.added', { targetType: 'channel', targetId: channel.id, detail: { count: added } });
    res.status(201).json({ ok: true, added, keys: listChannelKeys(db, channel.id) });
  });

  router.delete('/api/admin/channels/:id/keys/:keyId', (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const channel = getChannel(db, req.params.id);
    if (!channel) throw notFound('Channel not found');
    const key = db.get('SELECT * FROM channel_keys WHERE id = ? AND channel_id = ?', req.params.keyId, channel.id);
    if (!key) throw notFound('Channel key not found');
    db.run('DELETE FROM channel_keys WHERE id = ?', key.id);
    routing.invalidateKeys(channel.id);
    auditAs(app, session, 'channel.keys.deleted', { targetType: 'channel', targetId: channel.id, detail: { key_id: key.id, hint: key.hint } });
    res.json({ ok: true });
  });

  router.post('/api/admin/channels/:id/test', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const channel = getChannel(db, req.params.id);
    if (!channel) throw notFound('Channel not found');
    const result = await health.probe(channel.id, { manual: true });
    auditAs(app, session, 'channel.tested', { targetType: 'channel', targetId: channel.id, detail: { ok: result.ok, status_code: result.status_code } });
    res.json(result);
  });

  router.post('/api/admin/channels/:id/toggle', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const channel = getChannel(db, req.params.id);
    if (!channel) throw notFound('Channel not found');
    const body = await readJson(req, 64 * 1024);
    const status = body.status || (body.enabled ? 'enabled' : 'disabled');
    if (!['enabled', 'disabled'].includes(status)) throw badInput('status must be enabled or disabled');
    db.run('UPDATE channels SET status = ?, updated_at = ? WHERE id = ?', status, Date.now(), channel.id);
    routing.invalidate();
    auditAs(app, session, 'channel.toggled', { targetType: 'channel', targetId: channel.id, detail: { status } });
    res.json({ ok: true, status });
  });

  router.post('/api/admin/channels/:id/reset-circuit', (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const channel = getChannel(db, req.params.id);
    if (!channel) throw notFound('Channel not found');
    app.circuits.reset(channel.id);
    auditAs(app, session, 'channel.circuit_reset', { targetType: 'channel', targetId: channel.id });
    res.json({ ok: true, circuit: app.circuits.snapshot(channel.id) });
  });

  router.get('/api/admin/channels/:id/models', (req, res) => {
    requireAdmin(app, req, { roles: ['SUPER_ADMIN', 'AUDITOR'] });
    const channel = getChannel(db, req.params.id);
    if (!channel) throw notFound('Channel not found');
    res.json({ items: getChannelModels(db, channel.id) });
  });

  router.get('/api/admin/model-catalog', (req, res) => {
    requireAdmin(app, req);
    res.json({ items: db.all('SELECT * FROM models ORDER BY kind ASC, alias ASC').map(parseModel) });
  });
}
