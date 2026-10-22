import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockUpstream } from '../scripts/mock-upstream.js';
import { createApp } from '../src/server.js';

export async function startEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gateway-test-'));
  const mock = await startMockUpstream({ port: 0 });
  const { app, server, close } = await createApp({ dbPath: path.join(dir, 'gateway.db') });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await request(base, '/auth/login', {
    method: 'POST',
    body: { email: 'admin@corp.local', password: 'Admin@12345' },
  });
  if (login.status !== 200) throw new Error(`Admin login failed: ${login.status} ${login.text}`);
  const adminCookie = login.cookie;
  return {
    app,
    server,
    mock,
    base,
    adminCookie,
    dir,
    close: async () => {
      await close();
      await mock.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export async function request(base, path, { method = 'GET', body, cookie, headers = {}, signal } = {}) {
  const opts = { method, signal, headers: { Accept: 'application/json', ...headers } };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    headers: res.headers,
    text,
    json,
    cookie: setCookies[0]?.split(';')[0] || null,
  };
}

export async function adminApi(env, path, { method = 'GET', body } = {}) {
  return request(env.base, path, { method, body, cookie: env.adminCookie });
}

export async function login(env, email, password = 'Passw0rd!') {
  const res = await request(env.base, '/auth/login', { method: 'POST', body: { email, password } });
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${res.status} ${res.text}`);
  return res.cookie;
}

export async function createModel(env, alias, extra = {}) {
  const res = await adminApi(env, '/api/admin/models', {
    method: 'POST',
    body: {
      alias,
      name: extra.name || alias,
      description: 'test model',
      context_window: extra.context_window ?? 128000,
      max_output_tokens: 4096,
      input_price: extra.input_price ?? 0.001,
      output_price: extra.output_price ?? 0.002,
      capabilities: extra.capabilities || ['chat'],
      visible: extra.visible !== false,
      fallback_chain: extra.fallback_chain || [],
      kind: extra.kind || 'model',
      smart_group: extra.smart_group || null,
    },
  });
  if (res.status !== 201) throw new Error(`createModel ${alias} failed: ${res.status} ${res.text}`);
  return res.json.model;
}

export async function createChannel(env, { name, provider = 'openai', baseUrl, models, keys = ['sk-test-upstream'], priority = 5, weight = 10, headers = {} }) {
  const res = await adminApi(env, '/api/admin/channels', {
    method: 'POST',
    body: { name, provider, base_url: baseUrl, priority, weight, models, keys, headers },
  });
  if (res.status !== 201) throw new Error(`createChannel ${name} failed: ${res.status} ${res.text}`);
  return res.json.channel;
}

export async function createUser(env, { email, name = email, role = 'APP_USER', quota = 0, orgId, password = 'Passw0rd!' }) {
  const body = { email, name, role, password, monthly_quota_usd: quota };
  if (orgId) body.org_id = orgId;
  const res = await adminApi(env, '/api/admin/users', { method: 'POST', body });
  if (res.status !== 201) throw new Error(`createUser ${email} failed: ${res.status} ${res.text}`);
  return res.json.user;
}

export async function createKey(env, userId, extra = {}) {
  const res = await adminApi(env, '/api/admin/keys', {
    method: 'POST',
    body: { user_id: userId, name: extra.name || `key-${Date.now()}`, ...extra },
  });
  if (res.status !== 201) throw new Error(`createKey failed: ${res.status} ${res.text}`);
  return res.json;
}

export async function apiCall(env, key, path, body, extra = {}) {
  return request(env.base, path, {
    method: 'POST',
    body,
    headers: { Authorization: `Bearer ${key}`, ...extra },
  });
}

export function parseSse(text) {
  const events = [];
  for (const block of String(text).split(/\n\n/)) {
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') events.push('[DONE]');
      else {
        try { events.push(JSON.parse(payload)); } catch { /* ignore */ }
      }
    }
  }
  return events;
}
