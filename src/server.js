import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config as appConfig } from './config.js';
import { randomId, safeEqual } from './util/crypto.js';
import {
  Router, sendJson, sendText, readJson, getClientIp, normalizeIp, parseBasicAuth, setCommonHeaders,
} from './util/http.js';
import { GatewayError } from './util/errors.js';
import { Database } from './db/index.js';
import { SettingsService } from './services/settings.js';
import { Metrics } from './services/metrics.js';
import { AlertsService } from './services/alerts.js';
import { QuotaService } from './services/quota.js';
import { RateLimiter } from './services/rateLimit.js';
import { CircuitBreakerService } from './services/circuit.js';
import { RoutingService } from './services/routing.js';
import { LogStore } from './services/logs.js';
import { KeyAuthService } from './services/keyAuth.js';
import { AuthService } from './services/auth.js';
import { HealthService } from './services/health.js';
import { GatewayEngine } from './gateway/engine.js';
import { providersMeta } from './services/channels.js';
import { writeAudit } from './services/audit.js';
import { logger } from './util/logger.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAdminRoutes } from './admin/index.js';
import { registerPortalRoutes } from './portal/api.js';
import { assertSameOrigin } from './admin/helpers.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function loopback(ip) {
  const norm = normalizeIp(ip);
  return norm === '127.0.0.1' || norm === '::1' || norm === 'localhost';
}

function spaResponse(res, webDir) {
  const file = path.join(webDir, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) {
      sendText(res, 500, 'Web UI not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

function serveStatic(res, webDir, pathname) {
  const relative = pathname.replace(/^\/static\/?/, '');
  const resolved = path.resolve(webDir, relative);
  if (!resolved.startsWith(path.resolve(webDir) + path.sep)) {
    sendText(res, 404, 'Not found');
    return;
  }
  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(resolved).pipe(res);
  });
}

function sendError(res, err, requestId) {
  if (res.writableEnded || res.destroyed) return;
  const status = Number(err.status) || 500;
  const type = err.type || (status >= 500 ? 'server_error' : 'invalid_request_error');
  const code = err.code || (status >= 500 ? 'internal_error' : 'invalid_request');
  const payload = typeof err.toJSON === 'function'
    ? err.toJSON()
    : { error: { message: err.message || 'Internal server error', type, param: null, code } };
  const headers = { 'X-Request-Id': requestId, 'Cache-Control': 'no-store', ...(err.headers || {}) };
  if (res.headersSent) {
    try { res.end(); } catch { /* ignore */ }
    return;
  }
  sendJson(res, status, payload, headers);
}

export async function createApp({ dbPath } = {}) {
  const db = new Database(dbPath);
  await db.seed();
  const settings = new SettingsService(db);
  const metrics = new Metrics();
  const alerts = new AlertsService(db, settings);
  const quota = new QuotaService(db, settings);
  const limiter = new RateLimiter(settings);
  const circuits = new CircuitBreakerService(settings);
  const routing = new RoutingService(db, { settings, circuits, masterSecret: appConfig.masterSecret });
  const logStore = new LogStore(db);
  const keyAuth = new KeyAuthService(db, { masterSecret: appConfig.masterSecret, settings });
  const auth = new AuthService(db, { settings, logs: logStore, keyAuth });
  const health = new HealthService({ db, settings, circuits, routing });
  const engine = new GatewayEngine({
    db, config: { ...appConfig, dbPath: db.path }, settings, quota, limiter, circuits, metrics, logStore, routing, alerts,
  });

  quota.onThreshold = (info) => {
    alerts.raise({
      type: info.type,
      level: info.level,
      message: info.message,
      detail: {
        scope: info.scope.type,
        scope_id: info.scope.id,
        ratio: Number(info.ratio.toFixed(4)),
        spent_usd: Number(info.spent.toFixed(6)),
        limit_usd: info.limit,
        user_id: info.ctx?.user?.id,
        key_id: info.ctx?.key?.id,
        model: info.meta?.model,
      },
    });
  };
  circuits.onStateChange = ({ channelId, state, reason }) => {
    const channel = db.get('SELECT name FROM channels WHERE id = ?', channelId);
    alerts.raise({
      type: 'circuit_breaker',
      level: state === 'open' ? 'critical' : 'info',
      message: `渠道「${channel?.name || channelId}」断路器已${state === 'open' ? '熔断，流量将切换至备用渠道' : '恢复健康'}${reason ? `（${reason}）` : ''}`,
      detail: { channel_id: channelId, state, reason },
    });
  };

  const app = {
    db,
    config: { ...appConfig, dbPath: db.path },
    settings,
    metrics,
    alerts,
    quota,
    limiter,
    circuits,
    routing,
    logStore,
    keyAuth,
    auth,
    health,
    engine,
    providersMeta: providersMeta(),
    activeRequests: 0,
  };

  const router = new Router();
  registerAuthRoutes(router, app);
  registerAdminRoutes(router, app);
  registerPortalRoutes(router, app);

  const maxBodyMb = () => Math.min(100, Math.max(1, settings.getNumber('limits.max_body_mb', 32)));

  router.get('/healthz', (req, res) => {
    res.json({ status: 'ok', version: appConfig.version, uptime_seconds: Math.floor(process.uptime()), now: Date.now() });
  });

  router.get('/readyz', (req, res) => {
    try {
      db.get('SELECT 1 AS ok');
      res.json({ status: 'ready', db: 'ok', channels: db.get('SELECT COUNT(*) AS c FROM channels').c });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', error: err.message });
    }
  });

  router.get('/metrics', (req, res) => {
    const ip = getClientIp(req, appConfig.trustProxy);
    if (appConfig.metricsAuth) {
      const basic = parseBasicAuth(req.headers.authorization);
      if (!basic || !safeEqual(basic.user, appConfig.metricsAuth.user) || !safeEqual(basic.password, appConfig.metricsAuth.password)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="metrics"', 'Content-Type': 'text/plain' });
        res.end('Unauthorized');
        return;
      }
    } else if (!loopback(ip)) {
      sendText(res, 403, 'Metrics endpoint is restricted to loopback. Set METRICS_USER/METRICS_PASSWORD to enable Basic Auth.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(metrics.prometheus());
  });

  router.get('/v1/models', (req, res) => {
    const ip = getClientIp(req, appConfig.trustProxy);
    let ctx;
    try {
      ctx = keyAuth.authenticate(req, ip);
    } catch (err) {
      writeAudit(db, { actor: null, action: 'auth.api_key.failed', targetType: 'api', targetId: null, detail: { path: '/v1/models', ip }, ip });
      throw err;
    }
    res.json(engine.listModelsForContext(ctx, { onlyAvailable: true }));
  });

  router.get('/v1/models/:id', (req, res) => {
    const ip = getClientIp(req, appConfig.trustProxy);
    const ctx = keyAuth.authenticate(req, ip);
    const model = engine.getModelForContext(ctx, req.params.id);
    if (!model) {
      throw new GatewayError(`The model '${req.params.id}' does not exist`, {
        status: 404, type: 'invalid_request_error', code: 'model_not_found',
      });
    }
    res.json(model);
  });

  async function handleGateway(req, res, endpoint) {
    const ip = getClientIp(req, appConfig.trustProxy);
    const requestId = randomId('req_');
    res.setHeader('X-Request-Id', requestId);
    let ctx;
    try {
      ctx = keyAuth.authenticate(req, ip);
    } catch (err) {
      writeAudit(db, {
        actor: null, action: 'auth.api_key.failed', targetType: 'api', targetId: endpoint,
        detail: { path: `/v1/${endpoint}`, ip, reason: err.code }, ip,
      });
      throw err;
    }
    const body = await readJson(req, maxBodyMb() * 1024 * 1024);
    await engine.execute(req, res, { endpoint, body, ctx, requestId });
  }

  router.post('/v1/chat/completions', (req, res) => handleGateway(req, res, 'chat'));
  router.post('/v1/completions', (req, res) => handleGateway(req, res, 'completions'));
  router.post('/v1/embeddings', (req, res) => handleGateway(req, res, 'embeddings'));

  const server = http.createServer(async (req, res) => {
    const requestId = randomId('req_');
    res.headersSentRequestId = requestId;
    res.status = function status(code) { this.statusCode = code; return this; };
    res.json = function json(payload) { sendJson(this, this.statusCode || 200, payload); return this; };
    setCommonHeaders(res, requestId);

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      sendError(res, new GatewayError('Malformed URL', { status: 400, type: 'invalid_request_error', code: 'invalid_url' }), requestId);
      return;
    }

    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/v1/') || pathname.startsWith('/auth/') || pathname.startsWith('/metrics');
    if (isApi) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    if (appConfig.publicBaseUrl.startsWith('https://')) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }

    app.activeRequests++;
    let decremented = false;
    const release = () => {
      if (decremented) return;
      decremented = true;
      app.activeRequests = Math.max(0, app.activeRequests - 1);
    };
    res.once('finish', release);
    res.once('close', release);

    if (app.activeRequests > appConfig.maxConcurrentRequests) {
      sendError(res, new GatewayError('Gateway is temporarily overloaded. Please retry shortly.', {
        status: 503, type: 'server_error', code: 'overloaded', headers: { 'Retry-After': '1' },
      }), requestId);
      return;
    }

    const origin = req.headers.origin;
    if (origin && pathname.startsWith('/v1/')) {
      const allowed = appConfig.corsOrigins.includes(origin)
        || origin === (() => { try { return new URL(appConfig.publicBaseUrl).origin; } catch { return ''; } })()
        || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
      if (allowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Request-Id');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.setHeader('Vary', 'Origin');
      }
    }
    if (req.method === 'OPTIONS' && pathname.startsWith('/v1/')) {
      res.status(204).end();
      return;
    }

    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        if (pathname.startsWith('/api/') || pathname === '/auth/logout' || pathname === '/api/portal/playground') {
          assertSameOrigin(req);
        }
      }

      const match = router.match(req.method, pathname);
      if (match?.handler) {
        req.params = match.params || {};
        await match.handler(req, res, req.params);
        return;
      }
      if (match?.methodNotAllowed) {
        sendError(res, new GatewayError('Method not allowed', { status: 405, type: 'invalid_request_error', code: 'method_not_allowed' }), requestId);
        return;
      }

      if (pathname === '/' || pathname === '/login' || pathname === '/admin' || pathname === '/admin/' || pathname === '/portal' || pathname === '/portal/') {
        spaResponse(res, appConfig.webDir);
        return;
      }
      if (pathname.startsWith('/admin/') || pathname.startsWith('/portal/')) {
        spaResponse(res, appConfig.webDir);
        return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (pathname.startsWith('/static/')) {
        serveStatic(res, appConfig.webDir, pathname);
        return;
      }
      if (pathname.startsWith('/api/') || pathname.startsWith('/v1/') || pathname.startsWith('/auth/')) {
        sendError(res, new GatewayError('Not found', { status: 404, type: 'invalid_request_error', code: 'not_found' }), requestId);
        return;
      }
      sendText(res, 404, 'Not found');
    } catch (err) {
      const status = Number(err.status) || (err instanceof GatewayError ? err.status : 500);
      if (status >= 500) logger.error('request failed', { requestId, path: pathname, error: err.stack || err.message });
      else logger.debug('request rejected', { requestId, path: pathname, status, code: err.code });
      sendError(res, err, requestId);
    }
  });

  server.headersTimeout = 30000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65000;
  server.timeout = 0;

  const retentionTimer = setInterval(() => {
    try {
      const days = settings.getNumber('logs.retention_days', 90);
      if (days <= 0) return;
      const cutoff = Date.now() - days * 86400000;
      const result = db.run('DELETE FROM request_logs WHERE ts < ?', cutoff);
      if (result.changes) logger.info('pruned expired request logs', { rows: result.changes, retention_days: days });
    } catch (err) {
      logger.warn('log retention job failed', { error: err.message });
    }
  }, 6 * 3600 * 1000);
  retentionTimer.unref?.();

  async function close() {
    clearInterval(retentionTimer);
    health.stop();
    logStore.close();
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
      setTimeout(resolve, 1500).unref?.();
    });
    db.close();
  }

  return { app, server, close };
}
