import net from 'node:net';
import { readJson } from '../util/http.js';
import { createApiKey, listApiKeys, parseApiKey, apiKeyUsage } from '../services/keys.js';
import { getUser } from '../services/users.js';
import {
  requireAdmin, WRITE_ROLES, orgScope, badInput, notFound, requireString, requireNumber,
  ensureStringArray, auditAs,
} from './helpers.js';

function validateCidrList(list) {
  if (!Array.isArray(list)) throw badInput('ip_whitelist must be an array');
  for (const raw of list) {
    const rule = String(raw).trim();
    const [ip, bits] = rule.split('/');
    if (!net.isIP(ip)) throw badInput(`Invalid IP or CIDR: ${rule}`);
    if (bits !== undefined) {
      const n = Number(bits);
      const max = net.isIP(ip) === 4 ? 32 : 128;
      if (!Number.isInteger(n) || n < 0 || n > max) throw badInput(`Invalid CIDR prefix: ${rule}`);
    }
  }
  return list.map((v) => String(v).trim());
}

function keyLimits(app, body, { create, role } = {}) {
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
        if (alias !== '*' && !app.db.get('SELECT alias FROM models WHERE alias = ?', alias)) throw badInput(`Model '${alias}' does not exist`);
      }
      out.allowed_models = models;
    }
  }
  if (body.ip_whitelist !== undefined) {
    if (body.ip_whitelist === null || (Array.isArray(body.ip_whitelist) && body.ip_whitelist.length === 0)) out.ip_whitelist = null;
    else out.ip_whitelist = validateCidrList(body.ip_whitelist);
  }
  if (body.tags !== undefined) {
    const tags = ensureStringArray(body.tags, 'tags', { max: 10 }).map((t) => t.toUpperCase());
    if (tags.includes('PROD') && role !== 'SUPER_ADMIN') throw badInput('只有超级管理员可以设置 PROD 标签');
    out.tags = tags;
  }
  return out;
}

export function registerKeyRoutes(router, app) {
  const { db } = app;

  router.get('/api/admin/keys', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const url = new URL(req.url, 'http://localhost');
    const result = listApiKeys(db, {
      orgIds: scope,
      userId: url.searchParams.get('user_id') || undefined,
      status: url.searchParams.get('status') || undefined,
      q: url.searchParams.get('q') || undefined,
      page: url.searchParams.get('page'),
      page_size: url.searchParams.get('page_size'),
    });
    res.json(result);
  });

  router.get('/api/admin/keys/:id', (req, res) => {
    const session = requireAdmin(app, req);
    const key = parseApiKey(db.get('SELECT * FROM api_keys WHERE id = ?', req.params.id));
    if (!key) throw notFound('API key not found');
    const scope = orgScope(app, session);
    if (scope && !scope.includes(key.org_id)) throw notFound('API key not found');
    res.json({ key, usage: apiKeyUsage(db, key.id) });
  });

  router.post('/api/admin/keys', async (req, res) => {
    const session = requireAdmin(app, req, { roles: WRITE_ROLES, write: true });
    const body = await readJson(req, 256 * 1024);
    const user = getUser(db, body.user_id);
    if (!user) throw badInput('Target user not found');
    const scope = orgScope(app, session);
    if (scope && !scope.includes(user.org_id)) throw badInput('Cannot issue keys outside your organization');
    if (body.tags?.includes('PROD') && session.user.role !== 'SUPER_ADMIN') throw badInput('只有超级管理员可以设置 PROD 标签');
    const limits = keyLimits(app, body, { create: true, role: session.user.role });
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
      tags: limits.tags ?? (body.tags || []),
    });
    auditAs(app, session, 'key.issued_by_admin', {
      targetType: 'key', targetId: record.id,
      detail: { user_id: user.id, name: record.name, tags: record.tags },
    });
    res.status(201).json({ key: record, plaintext });
  });

  router.put('/api/admin/keys/:id', async (req, res) => {
    const session = requireAdmin(app, req, { roles: WRITE_ROLES, write: true });
    const key = parseApiKey(db.get('SELECT * FROM api_keys WHERE id = ?', req.params.id));
    if (!key) throw notFound('API key not found');
    const scope = orgScope(app, session);
    if (scope && !scope.includes(key.org_id)) throw notFound('API key not found');
    const body = await readJson(req, 256 * 1024);
    const limits = keyLimits(app, body, { create: false, role: session.user.role });
    if (session.user.role !== 'SUPER_ADMIN') delete limits.tags;
    const fields = [];
    const params = [];
    for (const [field, value] of Object.entries(limits)) {
      if (field === 'name' && !value) continue;
      fields.push(`${field} = ?`);
      if (['allowed_models', 'ip_whitelist', 'tags'].includes(field)) params.push(value === null ? null : JSON.stringify(value));
      else params.push(value);
    }
    if (body.status !== undefined) {
      if (!['active', 'disabled', 'revoked'].includes(body.status)) throw badInput('Invalid key status');
      fields.push('status = ?');
      params.push(body.status);
    }
    if (!fields.length) throw badInput('No fields to update');
    params.push(Date.now(), key.id);
    db.run(`UPDATE api_keys SET ${fields.join(', ')}, updated_at = ? WHERE id = ?`, ...params);
    app.keyAuth.invalidate(key.id);
    auditAs(app, session, 'key.updated', { targetType: 'key', targetId: key.id, detail: { fields: Object.keys(limits), status: body.status } });
    res.json({ key: parseApiKey(db.get('SELECT * FROM api_keys WHERE id = ?', key.id)) });
  });

  router.delete('/api/admin/keys/:id', (req, res) => {
    const session = requireAdmin(app, req, { roles: WRITE_ROLES, write: true });
    const key = parseApiKey(db.get('SELECT * FROM api_keys WHERE id = ?', req.params.id));
    if (!key) throw notFound('API key not found');
    const scope = orgScope(app, session);
    if (scope && !scope.includes(key.org_id)) throw notFound('API key not found');
    db.run("UPDATE api_keys SET status = 'revoked', updated_at = ? WHERE id = ?", Date.now(), key.id);
    app.keyAuth.invalidate(key.id);
    auditAs(app, session, 'key.revoked_by_admin', { targetType: 'key', targetId: key.id, detail: { name: key.name, user_id: key.user_id } });
    res.json({ ok: true });
  });
}
