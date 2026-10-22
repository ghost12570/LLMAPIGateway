import { readJson, redirect } from '../util/http.js';
import { forbidden } from '../util/errors.js';
import { writeAudit } from '../services/audit.js';

function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

export function registerAuthRoutes(router, app) {
  const { auth, settings } = app;

  router.get('/auth/config', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      platform_name: settings.get('platform.name', 'LLM Gateway'),
      local_login_enabled: settings.getBool('security.local_login_enabled', true),
      sso_providers: auth.publicSsoProviders(),
      demo_mode: app.config.demoMode,
      demo_credentials: app.config.demoMode
        ? { email: app.config.bootstrap.email, password: app.config.bootstrap.password }
        : null,
    });
  });

  router.post('/auth/login', async (req, res) => {
    const body = await readJson(req, 64 * 1024);
    const user = await auth.login(body.email, body.password, req.socket.remoteAddress, req.headers['user-agent']);
    auth.issueSession(res, user);
    res.setHeader('Cache-Control', 'no-store');
    const org = app.db.get('SELECT id, name FROM orgs WHERE id = ?', user.org_id);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role, org_id: user.org_id, org_name: org?.name },
    });
  });

  router.post('/auth/logout', (req, res) => {
    const session = auth.getUserFromRequest(req);
    auth.clearSession(res);
    if (session) {
      writeAudit(app.db, { actor: session.user, action: 'auth.logout', targetType: 'user', targetId: session.user.id, ip: req.socket.remoteAddress });
    }
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let session;
    try {
      session = auth.requireUser(req);
    } catch {
      res.status(401).json({ error: { message: 'Not authenticated', type: 'authentication_error', code: 'not_authenticated' } });
      return;
    }
    res.json({
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
        org_id: session.user.org_id,
        org_name: session.org.name,
        monthly_quota_usd: session.user.monthly_quota_usd,
        last_login_at: session.user.last_login_at,
      },
      permissions: {
        admin: ['SUPER_ADMIN', 'ORG_ADMIN', 'AUDITOR'].includes(session.user.role),
        manage_platform: session.user.role === 'SUPER_ADMIN',
        read_only: session.user.role === 'AUDITOR',
      },
      platform: {
        name: settings.get('platform.name', 'LLM Gateway'),
      },
    });
  });

  router.get('/auth/sso/:provider/start', async (req, res) => {
    const provider = auth.getProvider(req.params.provider);
    const url = new URL(req.url, 'http://localhost');
    const next = safeNext(url.searchParams.get('next') || '/portal');
    const authorizeUrl = await auth.buildAuthorizeUrl(provider, next);
    redirect(res, authorizeUrl);
  });

  router.get('/auth/sso/:provider/callback', async (req, res) => {
    const providerId = req.params.provider;
    const url = new URL(req.url, 'http://localhost');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error_description') || url.searchParams.get('error');
    if (error) {
      redirect(res, `/login?sso_error=${encodeURIComponent(error)}`);
      return;
    }
    if (!code || !state) {
      redirect(res, '/login?sso_error=Missing+authorization+code');
      return;
    }
    const pending = auth.ssoStates.get(state);
    const next = safeNext(pending?.next || '/portal');
    try {
      const result = await auth.ssoCallback(providerId, code, state, req.socket.remoteAddress);
      auth.issueSession(res, result.user);
      redirect(res, next);
    } catch (err) {
      redirect(res, `/login?sso_error=${encodeURIComponent(err.message || 'SSO login failed')}`);
    }
  });

  router.get('/api/auth/sso/:provider/start', async (req, res) => {
    const provider = auth.getProvider(req.params.provider);
    const url = new URL(req.url, 'http://localhost');
    const next = safeNext(url.searchParams.get('next') || '/portal');
    res.json({ url: await auth.buildAuthorizeUrl(provider, next) });
  });
}
