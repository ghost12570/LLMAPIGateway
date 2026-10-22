import fs from 'node:fs';
import path from 'node:path';
import { encryptSecret, randomId, hashPassword } from '../src/util/crypto.js';
import { createApiKey } from '../src/services/keys.js';

const DEMO_PASSWORD = 'Admin@12345';

function ensureOrg(app, name, parentId, quota) {
  let org = app.db.get('SELECT * FROM orgs WHERE name = ? AND parent_id IS ?', name, parentId);
  if (org) {
    app.db.run('UPDATE orgs SET monthly_quota_usd = ?, updated_at = ? WHERE id = ?', quota, Date.now(), org.id);
    return org;
  }
  const id = randomId('org_');
  const parent = parentId ? app.db.get('SELECT path FROM orgs WHERE id = ?', parentId) : null;
  const orgPath = parent ? `${parent.path}/${id}` : `/${id}`;
  app.db.run(
    'INSERT INTO orgs (id, name, parent_id, path, monthly_quota_usd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, name, parentId, orgPath, quota, 'active', Date.now(), Date.now(),
  );
  return app.db.get('SELECT * FROM orgs WHERE id = ?', id);
}

async function ensureUser(app, { email, name, role, orgId, passwordHash, quota = 0 }) {
  let user = app.db.get('SELECT * FROM users WHERE lower(email) = ?', email.toLowerCase());
  if (user) {
    app.db.run('UPDATE users SET name = ?, role = ?, org_id = ?, monthly_quota_usd = ?, updated_at = ? WHERE id = ?',
      name, role, orgId, quota, Date.now(), user.id);
    return app.db.get('SELECT * FROM users WHERE id = ?', user.id);
  }
  const id = randomId('usr_');
  const ts = Date.now();
  app.db.run(
    `INSERT INTO users (id, email, name, role, org_id, status, password_hash, auth_source, monthly_quota_usd, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, 'local', ?, ?, ?)`,
    id, email, name, role, orgId, passwordHash, quota, ts, ts,
  );
  return app.db.get('SELECT * FROM users WHERE id = ?', id);
}

function ensureChannel(app, { name, provider, baseUrl, priority, weight, models, keys, status = 'enabled' }) {
  let channel = app.db.get('SELECT * FROM channels WHERE name = ?', name);
  const ts = Date.now();
  if (channel) {
    app.db.run(
      `UPDATE channels SET provider = ?, base_url = ?, priority = ?, weight = ?, status = ?, updated_at = ? WHERE id = ?`,
      provider, baseUrl, priority, weight, status, ts, channel.id,
    );
  } else {
    const id = randomId('chn_');
    app.db.run(
      `INSERT INTO channels (id, name, provider, base_url, api_version, priority, weight, timeout_ms, first_byte_timeout_ms,
        concurrency_limit, status, headers, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 60000, 30000, 200, ?, '{}', ?, ?)`,
      id, name, provider, baseUrl, priority, weight, status, ts, ts,
    );
    channel = app.db.get('SELECT * FROM channels WHERE id = ?', id);
    for (const key of keys) {
      app.db.run(
        'INSERT INTO channel_keys (id, channel_id, encrypted_key, hint, status, weight, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        randomId('ck_'), channel.id, encryptSecret(app.config.masterSecret, key), `...${key.slice(-4)}`, 'active', 10, ts,
      );
    }
  }
  app.db.run('DELETE FROM channel_models WHERE channel_id = ?', channel.id);
  for (const m of models) {
    app.db.run('INSERT INTO channel_models (channel_id, model_alias, upstream_model, enabled, created_at) VALUES (?, ?, ?, 1, ?)',
      channel.id, m.alias, m.upstream, ts);
  }
  return app.db.get('SELECT * FROM channels WHERE id = ?', channel.id);
}

function loadKeysFile(app) {
  const file = path.join(app.config.dataDir, 'demo-keys.json');
  try { return { file, keys: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { file, keys: {} }; }
}

function saveKeysFile(file, keys) {
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
}

function ensureDemoKey(app, user, name, options, saved, file) {
  const mapKey = `${user.email}::${name}`;
  if (saved[mapKey]) {
    const row = app.db.get('SELECT * FROM api_keys WHERE user_id = ? AND name = ?', user.id, name);
    if (row && row.status === 'active') return { plaintext: saved[mapKey], record: row };
  }
  const { plaintext, record } = createApiKey(app.db, app.config.masterSecret, { user, name, ...options });
  saved[mapKey] = plaintext;
  saveKeysFile(file, saved);
  return { plaintext, record };
}

export async function seedDemo(app, { mockBaseUrl }) {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const root = app.db.get('SELECT * FROM orgs ORDER BY created_at ASC LIMIT 1');

  const tech = ensureOrg(app, '技术中心', root.id, 500);
  const algo = ensureOrg(app, '算法平台', tech.id, 300);
  const support = ensureOrg(app, '客户支持中心', root.id, 200);
  const growth = ensureOrg(app, '产品与增长', root.id, 150);

  const admin = app.db.get('SELECT * FROM users WHERE role = ?', 'SUPER_ADMIN');
  const orgAdmin = await ensureUser(app, { email: 'orgadmin@corp.local', name: '李明（技术中心）', role: 'ORG_ADMIN', orgId: tech.id, passwordHash, quota: 0 });
  const dev = await ensureUser(app, { email: 'dev@corp.local', name: '张伟（算法工程师）', role: 'APP_USER', orgId: algo.id, passwordHash, quota: 100 });
  const dev2 = await ensureUser(app, { email: 'alice@corp.local', name: '陈晓（后端研发）', role: 'APP_USER', orgId: tech.id, passwordHash, quota: 60 });
  const supporter = await ensureUser(app, { email: 'support@corp.local', name: '王芳（客服机器人）', role: 'APP_USER', orgId: support.id, passwordHash, quota: 80 });
  const marketing = await ensureUser(app, { email: 'growth@corp.local', name: '赵磊（产品增长）', role: 'APP_USER', orgId: growth.id, passwordHash, quota: 40 });
  const auditor = await ensureUser(app, { email: 'auditor@corp.local', name: '孙悦（财务审计）', role: 'AUDITOR', orgId: root.id, passwordHash, quota: 0 });

  const mockOpenAI = `${mockBaseUrl}/v1`;
  const mockAnthropic = `${mockBaseUrl}/anthropic`;
  const mockAzure = `${mockBaseUrl}/azure`;
  const models = app.db.all('SELECT alias FROM models').map((m) => m.alias);
  app.db.run(`UPDATE models SET visible = 1 WHERE alias IN (${models.map(() => '?').join(',')})`, ...models);

  ensureChannel(app, {
    name: 'OpenAI 官方主通道', provider: 'openai', baseUrl: mockOpenAI, priority: 1, weight: 60,
    models: [
      { alias: 'gpt-4o', upstream: 'gpt-4o' },
      { alias: 'gpt-4o-mini', upstream: 'gpt-4o-mini' },
      { alias: 'o1', upstream: 'o1' },
      { alias: 'o3-mini', upstream: 'o3-mini' },
      { alias: 'text-embedding-3-small', upstream: 'text-embedding-3-small' },
      { alias: 'text-embedding-3-large', upstream: 'text-embedding-3-large' },
    ],
    keys: ['sk-mock-openai-primary-001', 'sk-mock-openai-primary-002'],
  });
  ensureChannel(app, {
    name: 'Azure OpenAI 备用通道', provider: 'azure', baseUrl: mockAzure, priority: 2, weight: 30,
    models: [{ alias: 'gpt-4o', upstream: 'gpt-4o' }, { alias: 'gpt-4o-mini', upstream: 'gpt-4o-mini' }],
    keys: ['sk-mock-azure-backup-001'],
  });
  ensureChannel(app, {
    name: 'DeepSeek 官方', provider: 'deepseek', baseUrl: mockOpenAI, priority: 1, weight: 50,
    models: [
      { alias: 'deepseek-chat', upstream: 'deepseek-chat' },
      { alias: 'deepseek-reasoner', upstream: 'deepseek-reasoner' },
    ],
    keys: ['sk-mock-deepseek-001'],
  });
  ensureChannel(app, {
    name: 'Anthropic Claude', provider: 'anthropic', baseUrl: mockAnthropic, priority: 1, weight: 50,
    models: [
      { alias: 'claude-3-5-sonnet', upstream: 'claude-3-5-sonnet-20241022' },
      { alias: 'claude-3-5-haiku', upstream: 'claude-3-5-haiku-20241022' },
    ],
    keys: ['sk-ant-mock-001'],
  });
  ensureChannel(app, {
    name: '阿里云百炼（兼容模式）', provider: 'dashscope', baseUrl: mockOpenAI, priority: 2, weight: 40,
    models: [
      { alias: 'qwen-max', upstream: 'qwen-max' },
      { alias: 'qwen-plus', upstream: 'qwen-plus' },
      { alias: 'qwen-turbo', upstream: 'qwen-turbo' },
      { alias: 'qwen2.5-coder-32b', upstream: 'qwen2.5-coder-32b' },
    ],
    keys: ['sk-mock-dashscope-001'],
  });
  ensureChannel(app, {
    name: '内网 vLLM 集群', provider: 'custom', baseUrl: mockOpenAI, priority: 2, weight: 25,
    models: [
      { alias: 'qwen2.5-coder-32b', upstream: 'qwen2.5-coder-32b' },
      { alias: 'deepseek-chat', upstream: 'deepseek-chat' },
    ],
    keys: ['sk-mock-vllm-internal-001'],
  });

  const { file, keys: saved } = loadKeysFile(app);
  const devKeys = {
    cursor: ensureDemoKey(app, dev, 'Cursor-Local-Dev', { monthlyLimitUsd: 50, qpsLimit: 20, tpmLimit: 500000, tags: ['DEV'] }, saved, file),
    claude: ensureDemoKey(app, dev, 'Claude-Code', { monthlyLimitUsd: 80, qpsLimit: 30, tpmLimit: 800000, tags: ['DEV'] }, saved, file),
    prod: ensureDemoKey(app, dev, 'Prod-Customer-Agent', { monthlyLimitUsd: 200, qpsLimit: 100, tpmLimit: 2000000, tags: ['PROD'] }, saved, file),
    support: ensureDemoKey(app, supporter, 'Support-Bot', { monthlyLimitUsd: 100, qpsLimit: 50, tpmLimit: 1000000, tags: ['DEV'] }, saved, file),
    alice: ensureDemoKey(app, dev2, 'Backend-Service', { monthlyLimitUsd: 40, qpsLimit: 20, tags: ['DEV'] }, saved, file),
    marketing: ensureDemoKey(app, marketing, 'Growth-Copywriter', { monthlyLimitUsd: 30, tags: ['DEV'] }, saved, file),
  };

  app.routing.invalidate();
  app.keyAuth.invalidateAll();
  app.quota.invalidateOrgs();

  return {
    users: { admin, orgAdmin, dev, dev2, supporter, marketing, auditor },
    orgs: { tech, algo, support, growth },
    keys: devKeys,
    password: DEMO_PASSWORD,
  };
}

const TRAFFIC = [
  { model: 'gpt-4o', prompt: '请用三句话介绍我们的 LLM API Gateway 的核心价值。', stream: false, key: 'prod' },
  { model: 'gpt-4o-mini', prompt: '把这句话翻译成英文：统一接入，稳定可靠。', stream: true, key: 'cursor' },
  { model: 'claude-3-5-sonnet', prompt: '帮我评审这段 Python 代码的时间复杂度，并给出优化建议。', stream: true, key: 'claude' },
  { model: 'deepseek-reasoner', prompt: '一个班有 40 人，至少两人同一天生日的概率是多少？请给出推理过程。', stream: true, key: 'cursor' },
  { model: 'qwen-max', prompt: '为客服机器人写一段简洁的欢迎语，语气专业友好。', stream: false, key: 'support' },
  { model: 'auto', prompt: '总结一下本周的 API 调用趋势。', stream: true, key: 'prod' },
  { model: 'smart-coding', prompt: '用 TypeScript 实现一个带并发限制的 Promise 池。', stream: false, key: 'alice' },
  { model: 'gpt-4o', prompt: 'Write a short product announcement for an internal AI platform.', stream: true, key: 'marketing' },
  { model: 'qwen2.5-coder-32b', prompt: '解释什么是令牌桶算法，并给出 Redis Lua 实现思路。', stream: true, key: 'claude' },
  { model: 'deepseek-chat', prompt: '将以下需求拆解为 5 个开发任务：支持流式响应、用量计费、渠道熔断。', stream: false, key: 'alice' },
  { model: 'smart-reasoning', prompt: '如何在不影响在途流式连接的前提下完成网关平滑升级？', stream: true, key: 'prod' },
  { model: 'claude-3-5-haiku', prompt: '生成 3 条用于运营大屏的简短提示文案。', stream: false, key: 'marketing' },
  { model: 'qwen-plus', prompt: '写一段飞书机器人告警文案，说明部门配额已使用 85%。', stream: true, key: 'support' },
  { model: 'smart-fast', prompt: '用一句话解释 SSE 和 WebSocket 的区别。', stream: false, key: 'cursor' },
  { model: 'text-embedding-3-small', input: '企业级 LLM 网关的语义检索示例', embedding: true, key: 'alice' },
  { model: 'text-embedding-3-large', input: 'RAG knowledge base embedding', embedding: true, key: 'claude' },
  { model: 'gpt-4o', prompt: '为我们的渠道熔断策略设计一份监控指标清单。', stream: false, key: 'prod' },
  { model: 'deepseek-reasoner', prompt: '比较令牌桶与漏桶算法在高并发场景下的适用性。', stream: false, key: 'claude' },
];

export async function generateDemoTraffic(app, baseUrl, keys) {
  const keyMap = {
    prod: keys.prod.plaintext,
    cursor: keys.cursor.plaintext,
    claude: keys.claude.plaintext,
    support: keys.support.plaintext,
    alice: keys.alice.plaintext,
    marketing: keys.marketing.plaintext,
  };
  let ok = 0;
  let failed = 0;
  for (const item of TRAFFIC) {
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${keyMap[item.key]}` };
    try {
      if (item.embedding) {
        const res = await fetch(`${baseUrl}/v1/embeddings`, {
          method: 'POST', headers,
          body: JSON.stringify({ model: item.model, input: item.input }),
        });
        await res.text();
        if (res.ok) ok++; else failed++;
      } else {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: 'POST', headers,
          body: JSON.stringify({
            model: item.model,
            messages: [{ role: 'user', content: item.prompt }],
            stream: !!item.stream,
            stream_options: item.stream ? { include_usage: true } : undefined,
            max_tokens: 512,
          }),
        });
        const text = await res.text();
        if (res.ok && !text.includes('"error"')) ok++; else failed++;
      }
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  // One deliberate invalid-model request so the error panel and logs are populated.
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyMap.cursor}` },
      body: JSON.stringify({ model: 'gpt-5-ultra', messages: [{ role: 'user', content: 'test' }] }),
    });
    await res.text();
    failed++;
  } catch { /* ignore */ }
  return { ok, failed };
}

export function seedHistoricalLogs(app, { days = 21 } = {}) {
  if (app.settings.get('demo.history_seeded', '') === '1') return 0;
  const mappings = app.db.all(
    `SELECT cm.model_alias, cm.upstream_model, cm.channel_id, c.provider
     FROM channel_models cm JOIN channels c ON c.id = cm.channel_id
     WHERE cm.enabled = 1 AND c.status = 'enabled'`,
  );
  if (!mappings.length) return 0;
  const modelRows = app.db.all('SELECT alias, input_price, output_price FROM models');
  const prices = new Map(modelRows.map((m) => [m.alias, { in: m.input_price, out: m.output_price }]));
  const keys = app.db.all("SELECT id, user_id, org_id FROM api_keys WHERE status = 'active'");
  if (!keys.length) return 0;
  const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
  const pick = (arr) => arr[rand(0, arr.length - 1)];
  const markup = app.settings.getNumber('platform.markup_ratio', 1) || 1;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let count = 0;
  for (let d = days; d >= 0; d--) {
    const dayStart = today.getTime() - d * 86400000;
    const requests = d === 0
      ? Math.max(20, Math.min(120, Math.floor((Date.now() - dayStart) / 3600000) * 9))
      : rand(28, 78);
    for (let i = 0; i < requests; i++) {
      const mapping = pick(mappings);
      const key = pick(keys);
      const price = prices.get(mapping.model_alias) || { in: 0, out: 0 };
      const embedding = mapping.model_alias.includes('embedding');
      const promptTokens = embedding ? rand(300, 2400) : rand(400, 9000);
      const completionTokens = embedding ? 0 : rand(120, 2800);
      const stream = !embedding && Math.random() < 0.42;
      const success = Math.random() > 0.035;
      const source = Math.random() < 0.12 ? 'playground' : 'api';
      const cost = success ? ((promptTokens / 1000) * price.in + (completionTokens / 1000) * price.out) * markup : 0;
      app.logStore.record({
        id: `req_demo_${dayStart}_${i}_${Math.random().toString(36).slice(2, 8)}`,
        ts: d === 0
          ? dayStart + rand(0, Math.max(1, Math.floor((Date.now() - dayStart - 300000) / 1000))) * 1000
          : dayStart + rand(6 * 3600, 23 * 3600) * 1000,
        user_id: key.user_id,
        org_id: key.org_id,
        key_id: source === 'playground' ? null : key.id,
        source,
        endpoint: embedding ? 'embeddings' : 'chat',
        model: mapping.model_alias,
        upstream_model: mapping.upstream_model,
        channel_id: mapping.channel_id,
        provider: mapping.provider,
        stream,
        status: success ? 'success' : 'error',
        http_status: success ? 200 : (Math.random() < 0.5 ? 502 : 429),
        latency_ms: stream ? rand(600, 4200) : rand(120, 1500),
        ttft_ms: stream ? rand(40, 420) : null,
        prompt_tokens: promptTokens,
        completion_tokens: cost ? completionTokens : rand(0, 80),
        total_tokens: promptTokens + (cost ? completionTokens : 0),
        estimated: 0,
        cost_usd: Math.round(cost * 1e8) / 1e8,
        error_type: success ? null : (Math.random() < 0.5 ? 'server_error' : 'upstream_error'),
        error_code: success ? null : (Math.random() < 0.5 ? 'upstream_connection_failed' : 'upstream_rate_limit'),
        error_message: success ? null : '模拟历史故障：上游渠道抖动，已由降级链恢复',
        attempts: success && Math.random() < 0.08 ? 2 : 1,
        client_ip: `10.20.${rand(1, 30)}.${rand(2, 254)}`,
      });
      count++;
    }
  }
  app.logStore.flushSync();
  app.settings.set('demo.history_seeded', '1');
  return count;
}
