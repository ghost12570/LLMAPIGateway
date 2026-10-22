import fs from 'node:fs';
import os from 'node:os';
import { requireAdmin, orgScope, scopeClause } from './helpers.js';
import { listChannels } from '../services/channels.js';

function dayStart(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() + offsetDays * 86400000;
}

function monthStart() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function aggTotals(app, from, to, scope) {
  const sc = scopeClause(scope);
  return app.db.get(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successes,
            COALESCE(SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END), 0) AS errors,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0) AS cost_usd
     FROM request_logs WHERE ts >= ? AND ts < ?${sc.sql}`,
    from, to, ...sc.params,
  );
}

function parseAlert(row) {
  let detail = null;
  try { detail = row.detail ? JSON.parse(row.detail) : null; } catch { /* ignore */ }
  return { ...row, detail };
}

export function registerDashboardRoutes(router, app) {
  const { db, metrics } = app;

  router.get('/api/admin/overview', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const now = Date.now();
    const today = dayStart();
    const yesterday = dayStart(-1);
    const mStart = monthStart();

    const todayTotals = aggTotals(app, today, now + 1, scope);
    const monthTotals = aggTotals(app, mStart, now + 1, scope);
    const yesterdayTotals = aggTotals(app, yesterday, today, scope);

    const sc = scopeClause(scope);
    const bucket = 5 * 60 * 1000;
    const seriesStart = Math.floor((now - 24 * 3600 * 1000) / bucket) * bucket;
    const rawSeries = db.all(
      `SELECT CAST(ts / ? AS INTEGER) * ? AS bucket, COUNT(*) AS requests,
              SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM request_logs WHERE ts >= ? AND ts < ?${sc.sql}
       GROUP BY bucket ORDER BY bucket`,
      bucket, bucket, seriesStart, now + 1, ...sc.params,
    );
    const seriesMap = new Map(rawSeries.map((r) => [r.bucket, r]));
    const series = [];
    for (let ts = seriesStart; ts <= now; ts += bucket) {
      const row = seriesMap.get(ts) || { requests: 0, errors: 0, tokens: 0, cost: 0 };
      series.push({ ts, requests: row.requests, errors: row.errors, tokens: row.tokens, cost: row.cost });
    }

    const topModels = db.all(
      `SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS cost
       FROM request_logs WHERE ts >= ?${sc.sql} GROUP BY model ORDER BY cost DESC, requests DESC LIMIT 6`,
      today, ...sc.params,
    );
    const recentErrors = db.all(
      `SELECT id, ts, model, status, http_status, error_code, error_type, error_message, channel_id, latency_ms
       FROM request_logs WHERE ts >= ? AND status != 'success'${sc.sql} ORDER BY ts DESC LIMIT 6`,
      today, ...sc.params,
    );
    const recentRequests = db.all(
      `SELECT id, ts, model, status, http_status, latency_ms, ttft_ms, total_tokens, cost_usd, provider
       FROM request_logs WHERE ts >= ?${sc.sql} ORDER BY ts DESC LIMIT 8`,
      today, ...sc.params,
    );

    const channels = listChannels(db, app.circuits).map((c) => ({
      id: c.id, name: c.name, provider: c.provider, status: c.status,
      priority: c.priority, weight: c.weight,
      circuit: c.circuit, health: app.health.snapshot(c.id), key_count: c.key_count,
    }));
    const channelAvailability = channels.filter((c) => c.status === 'enabled').length
      ? Math.round((channels.filter((c) => c.status === 'enabled' && c.circuit.state === 'closed' && c.key_count > 0).length / channels.filter((c) => c.status === 'enabled').length) * 100)
      : 0;

    const activeKeys = scope
      ? db.get(`SELECT COUNT(*) AS c FROM api_keys WHERE status = 'active' AND org_id IN (${scope.map(() => '?').join(',') || "''"})`, ...scope).c
      : db.get("SELECT COUNT(*) AS c FROM api_keys WHERE status = 'active'").c;
    const activeUsers = scope
      ? db.get(`SELECT COUNT(*) AS c FROM users WHERE status = 'active' AND org_id IN (${scope.map(() => '?').join(',') || "''"})`, ...scope).c
      : db.get("SELECT COUNT(*) AS c FROM users WHERE status = 'active'").c;

    const successRate = todayTotals.requests ? todayTotals.successes / todayTotals.requests : 1;
    const yesterdayRate = yesterdayTotals.requests ? yesterdayTotals.successes / yesterdayTotals.requests : 1;

    res.json({
      now,
      today: {
        ...todayTotals,
        success_rate: successRate,
        yesterday_requests: yesterdayTotals.requests,
        yesterday_cost_usd: yesterdayTotals.cost_usd,
        yesterday_success_rate: yesterdayRate,
      },
      month: monthTotals,
      series,
      top_models: topModels,
      recent_errors: recentErrors,
      recent_requests: recentRequests,
      channels,
      channel_availability: channelAvailability,
      counts: { active_keys: activeKeys, active_users: activeUsers, channels: channels.length },
      live: metrics.live(),
      alerts: app.alerts.list(8).map(parseAlert),
      platform: {
        name: app.settings.get('platform.name', 'LLM Gateway'),
        currency: app.settings.get('platform.currency', 'CNY'),
        currency_rate: app.settings.getNumber('platform.currency_rate', 7.2),
        markup_ratio: app.settings.getNumber('platform.markup_ratio', 1),
      },
      role: session.user.role,
    });
  });

  router.get('/api/admin/alerts', (req, res) => {
    requireAdmin(app, req);
    const url = new URL(req.url, 'http://localhost');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    res.json({ items: app.alerts.list(limit).map(parseAlert) });
  });

  router.get('/api/admin/live', (req, res) => {
    requireAdmin(app, req);
    res.json(metrics.live());
  });

  router.get('/api/admin/system', (req, res) => {
    requireAdmin(app, req);
    let dbSize = 0;
    try { dbSize = fs.statSync(app.config.dbPath).size; } catch { /* ignore */ }
    const circuitStats = {};
    for (const c of db.all('SELECT id FROM channels')) {
      const snap = app.circuits.snapshot(c.id);
      circuitStats[snap.state] = (circuitStats[snap.state] || 0) + 1;
    }
    res.json({
      version: app.config.version,
      node: process.version,
      platform: `${os.type()} ${os.release()}`,
      uptime_seconds: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      cpu_count: os.cpus().length,
      loadavg: os.loadavg(),
      db_size_bytes: dbSize,
      db_path: app.config.dbPath,
      inflight: metrics.inflight,
      metrics: metrics.live(),
      circuits: circuitStats,
      sessions: { ttl_hours: app.settings.getNumber('security.session_ttl_hours', 12) },
      env: {
        trust_proxy: app.config.trustProxy,
        max_concurrent: app.config.maxConcurrentRequests,
        demo_mode: app.config.demoMode,
      },
    });
  });
}
