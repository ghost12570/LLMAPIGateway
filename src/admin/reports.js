import { requireAdmin, orgScope, badInput, notFound } from './helpers.js';
import { listAudit } from '../services/audit.js';

function parseTime(value, fallback, { endOfDay = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const str = String(value);
  if (/^\d+$/.test(str)) return Number(str);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getTime() + (endOfDay ? 86400000 : 0);
  }
  const ts = Date.parse(str);
  if (!Number.isFinite(ts)) throw badInput('Invalid date value');
  return ts;
}

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function logFilters(url, scope) {
  const filters = {
    from: parseTime(url.searchParams.get('from'), 0),
    to: parseTime(url.searchParams.get('to'), Date.now() + 1, { endOfDay: true }),
    status: url.searchParams.get('status') || undefined,
    model: url.searchParams.get('model') || undefined,
    user_id: url.searchParams.get('user_id') || undefined,
    key_id: url.searchParams.get('key_id') || undefined,
    channel_id: url.searchParams.get('channel_id') || undefined,
    http_status: url.searchParams.get('http_status') || undefined,
    request_id: url.searchParams.get('request_id') || undefined,
    source: url.searchParams.get('source') || undefined,
    q: url.searchParams.get('q') || undefined,
    page: url.searchParams.get('page'),
    page_size: url.searchParams.get('page_size'),
    org_ids: scope || undefined,
  };
  return filters;
}

function buildBilling(app, filters, groupBy) {
  const { db, logStore } = app;
  logStore.flushSync();
  const expression = {
    day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime')",
    org: 'org_id',
    model: 'model',
    user: 'user_id',
    channel: 'channel_id',
    provider: 'provider',
  }[groupBy];
  if (!expression) throw badInput('Invalid group_by value');
  if (filters.from >= filters.to) throw badInput('The "from" time must be earlier than "to"');

  const where = ['ts >= ?', 'ts < ?'];
  const params = [filters.from, filters.to];
  if (filters.org_ids) {
    if (!filters.org_ids.length) where.push('1=0');
    else { where.push(`org_id IN (${filters.org_ids.map(() => '?').join(',')})`); params.push(...filters.org_ids); }
  }
  if (filters.model) { where.push('model = ?'); params.push(filters.model); }
  if (filters.user_id) { where.push('user_id = ?'); params.push(filters.user_id); }
  const clause = `WHERE ${where.join(' AND ')}`;
  const summary = db.get(
    `SELECT COUNT(*) AS requests,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
     FROM request_logs ${clause}`,
    ...params,
  );
  const rows = db.all(
    `SELECT ${expression} AS group_key, COUNT(*) AS requests,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
     FROM request_logs ${clause}
     GROUP BY group_key ORDER BY cost_usd DESC LIMIT 500`,
    ...params,
  );

  const names = {};
  if (groupBy === 'org') {
    for (const o of db.all('SELECT id, name FROM orgs')) names[o.id] = o.name;
  } else if (groupBy === 'user') {
    for (const u of db.all('SELECT id, name, email FROM users')) names[u.id] = `${u.name} <${u.email}>`;
  } else if (groupBy === 'channel') {
    for (const c of db.all('SELECT id, name FROM channels')) names[c.id] = c.name;
  }
  const items = rows.map((r) => ({
    key: r.group_key,
    name: names[r.group_key] || r.group_key || 'unknown',
    requests: r.requests,
    prompt_tokens: r.prompt_tokens,
    completion_tokens: r.completion_tokens,
    total_tokens: r.total_tokens,
    cost_usd: r.cost_usd,
  }));
  return { summary, items, group_by: groupBy, from: filters.from, to: filters.to };
}

function csvEscape(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function registerReportRoutes(router, app) {
  const { db } = app;

  router.get('/api/admin/logs', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const url = new URL(req.url, 'http://localhost');
    const result = app.logStore.query(logFilters(url, scope));
    res.json(result);
  });

  router.get('/api/admin/logs/:id', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const log = app.logStore.get(req.params.id);
    if (!log) throw notFound('Log entry not found');
    if (scope && !scope.includes(log.org_id)) throw notFound('Log entry not found');
    res.json({ log });
  });

  router.get('/api/admin/billing', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const url = new URL(req.url, 'http://localhost');
    const filters = logFilters(url, scope);
    const groupBy = url.searchParams.get('group_by') || 'org';
    const data = buildBilling(app, filters, groupBy);
    res.json({
      ...data,
      currency: app.settings.get('platform.currency', 'CNY'),
      currency_rate: app.settings.getNumber('platform.currency_rate', 7.2),
      markup_ratio: app.settings.getNumber('platform.markup_ratio', 1),
    });
  });

  router.get('/api/admin/billing/export.csv', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const url = new URL(req.url, 'http://localhost');
    const filters = logFilters(url, scope);
    const groupBy = url.searchParams.get('group_by') || 'org';
    const data = buildBilling(app, filters, groupBy);
    const header = ['分组', '名称', '请求数', '输入Tokens', '输出Tokens', '总Tokens', '成本(USD)', '成本(CNY)'];
    const rate = app.settings.getNumber('platform.currency_rate', 7.2);
    const lines = [header.map(csvEscape).join(',')];
    for (const row of data.items) {
      lines.push([
        row.key, row.name, row.requests, row.prompt_tokens, row.completion_tokens,
        row.total_tokens, row.cost_usd.toFixed(6), (row.cost_usd * rate).toFixed(4),
      ].map(csvEscape).join(','));
    }
    lines.push(['合计', '', data.summary.requests, data.summary.prompt_tokens, data.summary.completion_tokens,
      data.summary.total_tokens, Number(data.summary.cost_usd).toFixed(6), (Number(data.summary.cost_usd) * rate).toFixed(4)].map(csvEscape).join(','));
    const csv = `\uFEFF${lines.join('\r\n')}\r\n`;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="llm-gateway-billing-${stamp}.csv"`,
      'Content-Length': Buffer.byteLength(csv),
    });
    res.end(csv);
  });

  router.get('/api/admin/audit', (req, res) => {
    const session = requireAdmin(app, req, { roles: ['SUPER_ADMIN', 'AUDITOR'] });
    const url = new URL(req.url, 'http://localhost');
    const result = listAudit(db, {
      action: url.searchParams.get('action') || undefined,
      q: url.searchParams.get('q') || undefined,
      page: url.searchParams.get('page'),
      page_size: url.searchParams.get('page_size'),
    });
    result.items = result.items.map((row) => {
      let detail = null;
      try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { /* ignore */ }
      return { ...row, detail };
    });
    res.json(result);
  });

  router.get('/api/admin/usage/daily', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const url = new URL(req.url, 'http://localhost');
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 30));
    app.logStore.flushSync();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = today.getTime() - (days - 1) * 86400000;
    const sc = scope
      ? { sql: scope.length ? ` AND org_id IN (${scope.map(() => '?').join(',')})` : ' AND 1=0', params: scope }
      : { sql: '', params: [] };
    const rows = db.all(
      `SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
       FROM request_logs WHERE ts >= ?${sc.sql}
       GROUP BY day ORDER BY day`,
      start, ...sc.params,
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const items = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start + i * 86400000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      items.push(byDay.get(key) || { day: key, requests: 0, tokens: 0, cost: 0 });
    }
    res.json({ items, days });
  });

  router.get('/api/admin/billing/summary', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const url = new URL(req.url, 'http://localhost');
    const from = parseTime(url.searchParams.get('from'), monthStart());
    const to = parseTime(url.searchParams.get('to'), Date.now() + 1, { endOfDay: true });
    const data = buildBilling(app, { from, to, org_ids: scope || undefined }, url.searchParams.get('group_by') || 'model');
    res.json(data);
  });
}
