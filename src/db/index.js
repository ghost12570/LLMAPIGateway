import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { randomId, hashPassword } from '../util/crypto.js';
import { logger } from '../util/logger.js';

const now = () => Date.now();

const MODEL_CATALOG = [
  ['gpt-4o', 'GPT-4o', 'OpenAI 旗舰多模态模型，综合能力强，适合复杂对话、视觉理解与工具调用。', 128000, 16384, 0.0025, 0.01, ['chat', 'vision', 'tools'], 1, ['claude-3-5-sonnet']],
  ['gpt-4o-mini', 'GPT-4o mini', '低延迟高性价比模型，适合海量日常请求、分类与轻量 Agent。', 128000, 16384, 0.00015, 0.0006, ['chat', 'vision', 'tools'], 1, ['deepseek-chat', 'qwen-plus']],
  ['o1', 'o1', 'OpenAI 深度推理模型，适合数学、算法与复杂规划任务。', 200000, 100000, 0.015, 0.06, ['chat', 'reasoning'], 1, ['deepseek-reasoner']],
  ['o3-mini', 'o3-mini', '高性价比推理模型，支持工具调用与结构化推理。', 200000, 100000, 0.0011, 0.0044, ['chat', 'reasoning', 'tools'], 1, ['deepseek-reasoner']],
  ['claude-3-5-sonnet', 'Claude 3.5 Sonnet', 'Anthropic 旗舰模型，代码、长文写作与复杂分析表现突出。', 200000, 8192, 0.003, 0.015, ['chat', 'vision', 'tools'], 1, ['gpt-4o']],
  ['claude-3-5-haiku', 'Claude 3.5 Haiku', 'Anthropic 轻量高速模型，适合实时客服与批量任务。', 200000, 8192, 0.0008, 0.004, ['chat', 'vision', 'tools'], 1, ['gpt-4o-mini']],
  ['deepseek-chat', 'DeepSeek V3', '国产高性价比通用模型，中文能力优秀，兼容 OpenAI 协议。', 64000, 8192, 0.00027, 0.0011, ['chat', 'tools'], 1, ['qwen-plus', 'gpt-4o-mini']],
  ['deepseek-reasoner', 'DeepSeek R1', '深度思维链推理模型，输出完整 reasoning_content。', 64000, 8192, 0.00055, 0.00219, ['chat', 'reasoning'], 1, ['o3-mini']],
  ['qwen-turbo', '通义千问 Turbo', '阿里百炼极速模型，适合高并发轻量任务。', 131072, 8192, 0.00005, 0.0002, ['chat', 'tools'], 1, ['qwen-plus']],
  ['qwen-plus', '通义千问 Plus', '阿里百炼均衡型模型，长上下文与中文理解能力优秀。', 131072, 8192, 0.0004, 0.0012, ['chat', 'tools'], 1, ['deepseek-chat']],
  ['qwen-max', '通义千问 Max', '阿里百炼旗舰模型，适合复杂业务与高质量内容生成。', 32768, 8192, 0.0016, 0.0064, ['chat', 'tools'], 1, ['gpt-4o']],
  ['qwen2.5-coder-32b', 'Qwen2.5 Coder 32B', '开源代码大模型，适合代码补全、审查与私有化部署。', 131072, 8192, 0.0004, 0.0012, ['chat', 'coding'], 1, ['claude-3-5-sonnet']],
  ['text-embedding-3-small', 'Embedding 3 Small', 'OpenAI 小型向量化模型，适合大规模 RAG 检索。', 8191, 0, 0.00002, 0, ['embedding'], 1, []],
  ['text-embedding-3-large', 'Embedding 3 Large', 'OpenAI 高精度向量化模型，适合高召回知识库。', 8191, 0, 0.00013, 0, ['embedding'], 1, []],
];

const ROUTER_CATALOG = [
  ['auto', 'Auto 智能路由', '根据 Prompt 长度、是否包含代码或工具调用，自动选择最具性价比的可用模型。', 'auto'],
  ['smart-fast', 'Smart Fast', '自动路由至低延迟、低成本的快速模型。', 'fast'],
  ['smart-coding', 'Smart Coding', '自动路由至代码能力最强的模型。', 'coding'],
  ['smart-reasoning', 'Smart Reasoning', '自动路由至深度推理/思维链模型。', 'reasoning'],
];

export const DEFAULT_SETTINGS = {
  'platform.name': 'LLM Gateway',
  'platform.markup_ratio': '1.0',
  'platform.currency': 'CNY',
  'platform.currency_rate': '7.20',
  'limits.default_qps': '20',
  'limits.default_tpm': '500000',
  'limits.max_body_mb': '32',
  'limits.max_attempts': '3',
  'routing.order_strategy': 'weighted',
  'limits.min_completion_reserve': '256',
  'quota.soft_ratio': '0.85',
  'quota.overdraft_prod_ratio': '0.2',
  'circuit.failure_threshold': '3',
  'circuit.window_size': '20',
  'circuit.error_rate': '0.25',
  'circuit.cooldown_ms': '30000',
  'health.interval_ms': '30000',
  'sse.heartbeat_ms': '15000',
  'logs.retention_days': '90',
  'security.local_login_enabled': 'true',
  'security.session_ttl_hours': '12',
  'alert.webhook_url': '',
  'alert.webhook_type': 'feishu',
  'smart_routes': JSON.stringify({
    'smart-fast': { strategy: 'fast' },
    'smart-coding': { strategy: 'coding' },
    'smart-reasoning': { strategy: 'reasoning' },
    auto: { strategy: 'auto' },
    groups: {
      fast: ['gpt-4o-mini', 'deepseek-chat', 'qwen-plus'],
      coding: ['claude-3-5-sonnet', 'qwen2.5-coder-32b', 'deepseek-chat'],
      reasoning: ['deepseek-reasoner', 'o3-mini', 'o1'],
      flagship: ['gpt-4o', 'claude-3-5-sonnet', 'qwen-max'],
    },
  }),
  'sso.providers': JSON.stringify([
    {
      id: 'feishu',
      name: '飞书',
      type: 'feishu',
      enabled: false,
      client_id: '',
      client_secret: '',
      authorize_url: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
      scope: '',
      redirect_path: '/auth/sso/feishu/callback',
    },
    {
      id: 'dingtalk',
      name: '钉钉',
      type: 'dingtalk',
      enabled: false,
      client_id: '',
      client_secret: '',
      authorize_url: 'https://login.dingtalk.com/oauth2/auth',
      scope: 'openid',
      redirect_path: '/auth/sso/dingtalk/callback',
    },
    {
      id: 'oidc',
      name: '企业 OIDC',
      type: 'oidc',
      enabled: false,
      issuer: '',
      client_id: '',
      client_secret: '',
      scope: 'openid profile email',
      redirect_path: '/auth/sso/oidc/callback',
    },
  ]),
  'sso.auto_create': 'true',
  'sso.default_role': 'APP_USER',
  'sso.default_org_id': '',
};

export class Database {
  constructor(file = config.dbPath) {
    this.file = file;
    this.path = file;
    fs.mkdirSync(file.replace(/[/\\][^/\\]+$/, ''), { recursive: true });
    this.db = new DatabaseSync(file);
    this.statements = new Map();
    this.db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params);
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...params);
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...params);
  }

  exec(sql) {
    this.db.exec(sql);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }

  close() {
    this.statements.clear();
    this.db.close();
  }

  async seed() {
    this.seedSettings();
    await this.seedAdmin();
    this.seedModels();
    logger.info('database seeded', { file: this.file });
  }

  seedSettings() {
    const ts = now();
    const insert = this.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
    this.transaction(() => {
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insert.run(key, value, ts);
    });
  }

  seedModels() {
    const ts = now();
    const insert = this.prepare(`INSERT OR IGNORE INTO models
      (alias, name, description, context_window, max_output_tokens, input_price, output_price, capabilities, visible, fallback_chain, kind, smart_group, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.transaction(() => {
      for (const m of MODEL_CATALOG) {
        insert.run(m[0], m[1], m[2], m[3], m[4], m[5], m[6], JSON.stringify(m[7]), m[8], JSON.stringify(m[9]), 'model', null, ts, ts);
      }
      for (const [alias, name, description, group] of ROUTER_CATALOG) {
        insert.run(alias, name, description, 0, 0, 0, 0, JSON.stringify(['router']), 0, '[]', 'router', group, ts, ts);
      }
    });
  }

  async seedAdmin() {
    const existing = this.get("SELECT id FROM users WHERE role = 'SUPER_ADMIN' LIMIT 1");
    if (existing) return;

    let org = this.get('SELECT * FROM orgs ORDER BY created_at ASC LIMIT 1');
    const ts = now();
    if (!org) {
      const orgId = randomId('org_');
      this.run('INSERT INTO orgs (id, name, parent_id, path, monthly_quota_usd, status, created_at, updated_at) VALUES (?, ?, NULL, ?, 0, ?, ?, ?)',
        orgId, '总部', `/${orgId}`, 'active', ts, ts);
      org = this.get('SELECT * FROM orgs WHERE id = ?', orgId);
    }

    const email = config.bootstrap.email.toLowerCase();
    const existingUser = this.get('SELECT id FROM users WHERE email = ?', email);
    if (existingUser) {
      this.run("UPDATE users SET role = 'SUPER_ADMIN', status = 'active', updated_at = ? WHERE id = ?", ts, existingUser.id);
      logger.warn('existing bootstrap user promoted to SUPER_ADMIN', { email });
      return;
    }

    const passwordHash = await hashPassword(config.bootstrap.password);
    const userId = randomId('usr_');
    this.run(`INSERT INTO users (id, email, name, employee_no, role, org_id, status, password_hash, auth_source,
      monthly_quota_usd, created_at, updated_at) VALUES (?, ?, ?, NULL, 'SUPER_ADMIN', ?, 'active', ?, 'local', 0, ?, ?)`,
    userId, email, config.bootstrap.name, org.id, passwordHash, ts, ts);
    logger.info('bootstrap admin created', { email });
  }
}
