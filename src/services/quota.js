import { logger } from '../util/logger.js';

const round8 = (n) => Math.round(n * 1e8) / 1e8;

export class QuotaService {
  constructor(db, settings) {
    this.db = db;
    this.settings = settings;
    this.periodStart = this.monthStart();
    this.userSpent = new Map();
    this.keySpent = new Map();
    this.keyTotalSpent = new Map();
    this.orgSpent = new Map();
    this.reserved = new Map();
    this.reservations = new Map();
    this.onThreshold = null;
    this.orgCache = null;
    this.orgCacheAt = 0;
    this.costMultiplier = () => this.settings.getNumber('platform.markup_ratio', 1) || 1;
  }

  invalidateOrgs() {
    this.orgCache = null;
    this.orgCacheAt = 0;
  }

  getOrgCached(id) {
    if (!this.orgCache || Date.now() - this.orgCacheAt > 30000) {
      this.orgCache = new Map(this.db.all('SELECT id, name, parent_id, monthly_quota_usd, path FROM orgs').map((o) => [o.id, o]));
      this.orgCacheAt = Date.now();
    }
    return this.orgCache.get(id) || null;
  }

  monthStart(at = Date.now()) {
    const d = new Date(at);
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  periodKey(at = Date.now()) {
    const d = new Date(at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  maybeRollover() {
    const start = this.monthStart();
    if (start !== this.periodStart) {
      this.periodStart = start;
      this.userSpent.clear();
      this.keySpent.clear();
      this.orgSpent.clear();
      this.reserved.clear();
      this.reservations.clear();
      logger.info('quota period rolled over', { period: this.periodKey() });
    }
  }

  orgLineage(orgId) {
    const out = [];
    let current = orgId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const org = this.getOrgCached(current);
      if (!org) break;
      out.push(org);
      current = org.parent_id;
    }
    return out;
  }

  getSpent(type, id) {
    this.maybeRollover();
    const map = type === 'user' ? this.userSpent
      : type === 'key' ? this.keySpent
      : type === 'key_total' ? this.keyTotalSpent
      : this.orgSpent;
    if (map.has(id)) return map.get(id);
    let value = 0;
    if (type === 'user') {
      value = this.db.get('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM request_logs WHERE user_id = ? AND ts >= ?', id, this.periodStart).s;
    } else if (type === 'key') {
      value = this.db.get('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM request_logs WHERE key_id = ? AND ts >= ?', id, this.periodStart).s;
    } else if (type === 'key_total') {
      value = this.db.get('SELECT COALESCE(SUM(cost_usd), 0) AS s FROM request_logs WHERE key_id = ?', id).s;
    } else {
      const org = this.db.get('SELECT path FROM orgs WHERE id = ?', id);
      if (!org) value = 0;
      else {
        value = this.db.get(
          `SELECT COALESCE(SUM(l.cost_usd), 0) AS s FROM request_logs l
           JOIN orgs o ON o.id = l.org_id
           WHERE l.ts >= ? AND (o.path = ? OR o.path LIKE ?)`,
          this.periodStart, org.path, `${org.path}/%`,
        ).s;
      }
    }
    map.set(id, value);
    return value;
  }

  scopeKey(type, id) {
    return `${type}:${id}`;
  }

  reservedFor(type, id) {
    return this.reserved.get(this.scopeKey(type, id)) || 0;
  }

  /** Build the list of quota scopes that apply to this principal. */
  scopesFor(ctx) {
    const scopes = [];
    if (ctx.user) {
      scopes.push({ type: 'user', id: ctx.user.id, limit: Number(ctx.user.monthly_quota_usd) || 0, label: '个人月度配额' });
      const lineage = this.orgLineage(ctx.user.org_id);
      for (const org of lineage) {
        scopes.push({ type: 'org', id: org.id, limit: Number(org.monthly_quota_usd) || 0, label: `部门配额（${org.name}）` });
      }
    }
    if (ctx.key) {
      scopes.push({ type: 'key', id: ctx.key.id, limit: Number(ctx.key.monthly_limit_usd) || 0, label: 'API Key 月度限额' });
      if (Number(ctx.key.total_limit_usd) > 0) {
        scopes.push({ type: 'key_total', id: ctx.key.id, limit: Number(ctx.key.total_limit_usd), label: 'API Key 总额度' });
      }
    }
    return scopes;
  }

  isProd(ctx) {
    const tags = Array.isArray(ctx.key?.tags) ? ctx.key.tags : [];
    return tags.map((t) => String(t).toUpperCase()).includes('PROD');
  }

  allowedLimit(scope, ctx) {
    if (scope.limit <= 0) return Infinity;
    if (scope.type === 'key' && this.isProd(ctx)) {
      const ratio = this.settings.getNumber('quota.overdraft_prod_ratio', 0.2);
      return scope.limit * (1 + ratio);
    }
    return scope.limit;
  }

  /**
   * Reserve an estimated cost atomically across all scopes.
   * @returns {{ok: boolean, scope?: object, message?: string}}
   */
  reserve(ctx, requestId, estimatedCost) {
    this.maybeRollover();
    const amount = Math.max(0, round8(estimatedCost));
    const scopes = this.scopesFor(ctx);
    const entries = [];
    for (const scope of scopes) {
      const limit = this.allowedLimit(scope, ctx);
      if (!Number.isFinite(limit)) continue;
      const spent = this.getSpent(scope.type, scope.id);
      const reserved = this.reservedFor(scope.type, scope.id);
      if (spent + reserved + amount > limit + 1e-9) {
        this.release(requestId);
        return {
          ok: false,
          scope,
          message: `${scope.label}不足：已用 $${spent.toFixed(4)}，处理中 $${reserved.toFixed(4)}，本次预估 $${amount.toFixed(4)}，上限 $${scope.limit.toFixed(2)}`,
        };
      }
      entries.push({ type: scope.type, id: scope.id, amount });
    }
    this.reservations.set(requestId, entries);
    for (const e of entries) {
      const key = this.scopeKey(e.type, e.id);
      this.reserved.set(key, (this.reserved.get(key) || 0) + e.amount);
    }
    return { ok: true };
  }

  release(requestId) {
    const entries = this.reservations.get(requestId);
    if (!entries) return;
    for (const e of entries) {
      const key = this.scopeKey(e.type, e.id);
      const next = (this.reserved.get(key) || 0) - e.amount;
      if (next > 1e-12) this.reserved.set(key, next);
      else this.reserved.delete(key);
    }
    this.reservations.delete(requestId);
  }

  settle(ctx, requestId, actualCost, meta = {}) {
    this.maybeRollover();
    this.release(requestId);
    const cost = Math.max(0, round8(actualCost));
    if (!cost) return;
    const scopes = this.scopesFor(ctx);
    for (const scope of scopes) {
      const map = scope.type === 'user' ? this.userSpent
        : scope.type === 'key' ? this.keySpent
        : scope.type === 'key_total' ? this.keyTotalSpent
        : this.orgSpent;
      map.set(scope.id, (map.get(scope.id) || 0) + cost);
    }
    this.checkThresholds(ctx, scopes, meta);
  }

  checkThresholds(ctx, scopes, meta) {
    const softRatio = this.settings.getNumber('quota.soft_ratio', 0.85);
    for (const scope of scopes) {
      if (scope.limit <= 0) continue;
      const spent = this.getSpent(scope.type, scope.id);
      const ratio = spent / scope.limit;
      for (const [threshold, level] of [[softRatio, 'warning'], [1, 'critical']]) {
        if (ratio + 1e-9 < threshold) continue;
        const alertKey = `quota:${scope.type}:${scope.id}:${this.periodKey()}:${threshold}`;
        const inserted = this.db.run('INSERT OR IGNORE INTO alert_state (key, fired_at) VALUES (?, ?)', alertKey, Date.now());
        if (!inserted.changes) continue;
        if (this.onThreshold) {
          this.onThreshold({
            level,
            type: 'quota_threshold',
            scope,
            ratio,
            spent,
            limit: scope.limit,
            ctx,
            meta,
            message: `${scope.label}已使用 ${(ratio * 100).toFixed(1)}%（$${spent.toFixed(2)} / $${scope.limit.toFixed(2)}）`,
          });
        }
      }
    }
  }

  releaseAll() {
    this.reservations.clear();
    this.reserved.clear();
  }

  snapshot(ctx) {
    this.maybeRollover();
    const userSpent = ctx.user ? this.getSpent('user', ctx.user.id) : 0;
    const keySpent = ctx.key ? this.getSpent('key', ctx.key.id) : 0;
    const keyTotalSpent = ctx.key ? this.getSpent('key_total', ctx.key.id) : 0;
    const orgSpent = ctx.user ? this.getSpent('org', ctx.user.org_id) : 0;
    return {
      user_spent: round8(userSpent),
      user_limit: Number(ctx.user?.monthly_quota_usd) || 0,
      key_spent: round8(keySpent),
      key_limit: Number(ctx.key?.monthly_limit_usd) || 0,
      key_total_spent: round8(keyTotalSpent),
      key_total_limit: Number(ctx.key?.total_limit_usd) || 0,
      org_spent: round8(orgSpent),
      org_limit: Number(ctx.quotaOrg?.monthly_quota_usd) || 0,
      period: this.periodKey(),
    };
  }

  estimateCost(model, promptTokens, completionTokens) {
    const input = Number(model?.input_price) || 0;
    const output = Number(model?.output_price) || 0;
    return round8(((promptTokens / 1000) * input + (completionTokens / 1000) * output) * this.costMultiplier());
  }
}
