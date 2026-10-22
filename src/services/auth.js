import crypto from 'node:crypto';
import { config } from '../config.js';
import { parseCookies, serializeCookie, clearCookie, jsonFetch } from '../util/http.js';
import { signSession, verifySession, hashPassword, verifyPassword, sha256Hex, randomString, randomId, decryptSecret } from '../util/crypto.js';
import { GatewayError, badRequest, forbidden, unauthorized } from '../util/errors.js';
import { getUser, getOrg } from './users.js';
import { writeAudit } from './audit.js';
import { logger } from '../util/logger.js';

const sessionSecret = sha256Hex(`${config.masterSecret}:session`);

function textOf(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function verifyJwt(token, jwks, { issuer, audience, nonce }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token');
  const header = JSON.parse(base64urlDecode(parts[0]).toString('utf8'));
  const payload = JSON.parse(base64urlDecode(parts[1]).toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('id_token expired');
  if (issuer && payload.iss !== issuer) throw new Error(`Unexpected id_token issuer: ${payload.iss}`);
  if (audience) {
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(audience)) throw new Error('id_token audience mismatch');
  }
  if (nonce && payload.nonce !== nonce) throw new Error('id_token nonce mismatch');
  const jwk = jwks.keys?.find((k) => k.kid === header.kid) || jwks.keys?.[0];
  if (!jwk) throw new Error('No JWKS key available to verify id_token');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = base64urlDecode(parts[2]);
  const alg = header.alg;
  let ok;
  if (alg === 'ES256') {
    ok = crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } else if (['RS256', 'RS384', 'RS512'].includes(alg)) {
    ok = crypto.verify(alg === 'RS256' ? 'sha256' : alg === 'RS384' ? 'sha384' : 'sha512', data, key, signature);
  } else {
    throw new Error(`Unsupported id_token algorithm: ${alg}`);
  }
  if (!ok) throw new Error('id_token signature verification failed');
  return payload;
}

export class AuthService {
  constructor(db, { settings, logs, keyAuth }) {
    this.db = db;
    this.settings = settings;
    this.logStore = logs;
    this.keyAuth = keyAuth;
    this.loginAttempts = new Map();
    this.ssoStates = new Map();
    this.discoveryCache = new Map();
    this.timer = setInterval(() => {
      const cutoff = Date.now() - 10 * 60 * 1000;
      for (const [key, entry] of this.ssoStates) if (entry.createdAt < cutoff) this.ssoStates.delete(key);
      for (const [key, entry] of this.loginAttempts) if (entry.resetAt < Date.now()) this.loginAttempts.delete(key);
    }, 5 * 60 * 1000);
    this.timer.unref?.();
  }

  secureCookies() {
    return config.publicBaseUrl.startsWith('https://');
  }

  sessionFor(user) {
    return signSession(sessionSecret, { sub: user.id, role: user.role }, config.sessionTtlSec);
  }

  issueSession(res, user) {
    const token = this.sessionFor(user);
    res.setHeader('Set-Cookie', serializeCookie(config.cookieName, token, {
      maxAge: config.sessionTtlSec,
      httpOnly: true,
      sameSite: 'Lax',
      secure: this.secureCookies(),
    }));
  }

  clearSession(res) {
    res.setHeader('Set-Cookie', clearCookie(config.cookieName));
  }

  getUserFromRequest(req) {
    const cookies = parseCookies(req);
    const token = cookies[config.cookieName];
    if (!token) return null;
    const payload = verifySession(sessionSecret, token);
    if (!payload?.sub) return null;
    const user = getUser(this.db, payload.sub);
    if (!user || user.status !== 'active') return null;
    const org = getOrg(this.db, user.org_id);
    if (!org) return null;
    delete user.password_hash;
    return { user, org };
  }

  requireUser(req) {
    const session = this.getUserFromRequest(req);
    if (!session) throw unauthorized('Authentication required. Please sign in.');
    return session;
  }

  checkLoginRate(key) {
    const entry = this.loginAttempts.get(key);
    if (!entry) return;
    if (entry.resetAt < Date.now()) {
      this.loginAttempts.delete(key);
      return;
    }
    if (entry.count >= 8) {
      const wait = Math.ceil((entry.resetAt - Date.now()) / 1000);
      throw new GatewayError(`Too many login attempts. Try again in ${wait}s.`, {
        status: 429, type: 'rate_limit_error', code: 'login_rate_limited', headers: { 'Retry-After': String(wait) },
      });
    }
  }

  bumpLoginFailure(key) {
    const entry = this.loginAttempts.get(key) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
    entry.count++;
    this.loginAttempts.set(key, entry);
  }

  async login(email, password, ip, userAgent) {
    if (!this.settings.getBool('security.local_login_enabled', true)) {
      throw forbidden('Password login is disabled. Please use your corporate SSO.', 'local_login_disabled');
    }
    const normalized = String(email || '').trim().toLowerCase();
    const rateKey = `${ip}:${normalized}`;
    this.checkLoginRate(rateKey);
    if (!normalized || !password) throw badRequest('Email and password are required', 'invalid_credentials');
    const user = this.db.get('SELECT * FROM users WHERE lower(email) = ?', normalized);
    if (!user || !user.password_hash) {
      this.bumpLoginFailure(rateKey);
      writeAudit(this.db, { actor: null, action: 'auth.login.failed', targetType: 'user', targetId: normalized, detail: { reason: 'invalid_credentials' }, ip });
      throw unauthorized('Invalid email or password', 'invalid_credentials');
    }
    if (user.status !== 'active') throw forbidden('This account has been frozen', 'account_frozen');
    const ok = await verifyPassword(String(password), user.password_hash);
    if (!ok) {
      this.bumpLoginFailure(rateKey);
      writeAudit(this.db, { actor: null, action: 'auth.login.failed', targetType: 'user', targetId: normalized, detail: { reason: 'invalid_credentials' }, ip });
      throw unauthorized('Invalid email or password', 'invalid_credentials');
    }
    this.loginAttempts.delete(rateKey);
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
    writeAudit(this.db, { actor: user, action: 'auth.login.success', targetType: 'user', targetId: user.id, detail: { user_agent: String(userAgent || '').slice(0, 200) }, ip });
    delete user.password_hash;
    return user;
  }

  publicSsoProviders() {
    const providers = this.settings.getJSON('sso.providers', []);
    return providers.filter((p) => p.enabled).map((p) => ({ id: p.id, name: p.name, type: p.type }));
  }

  getProvider(id) {
    const providers = this.settings.getJSON('sso.providers', []);
    const found = providers.find((p) => p.id === id);
    if (!found || !found.enabled) throw new GatewayError('SSO provider not found or disabled', { status: 404, type: 'invalid_request_error', code: 'sso_provider_not_found' });
    if (!found.client_id) throw new GatewayError('SSO provider is not fully configured', { status: 500, type: 'gateway_error', code: 'sso_not_configured' });
    const provider = { ...found };
    if (provider.client_secret?.startsWith('enc:v1:')) {
      try { provider.client_secret = decryptSecret(config.masterSecret, provider.client_secret.slice(7)); } catch { provider.client_secret = ''; }
    }
    return provider;
  }

  redirectUri(provider) {
    return `${config.publicBaseUrl}${provider.redirect_path || `/auth/sso/${provider.id}/callback`}`;
  }

  async discovery(provider) {
    if (provider.type !== 'oidc') return null;
    const issuer = provider.issuer.replace(/\/$/, '');
    const cached = this.discoveryCache.get(issuer);
    if (cached && cached.expires > Date.now()) return cached.value;
    const { res, json } = await jsonFetch(`${issuer}/.well-known/openid-configuration`, {}, 10000);
    if (!res.ok || !json) throw new GatewayError(`Failed to load OIDC discovery document (${res.status})`, { status: 502, type: 'gateway_error', code: 'sso_discovery_failed' });
    this.discoveryCache.set(issuer, { value: json, expires: Date.now() + 10 * 60 * 1000 });
    return json;
  }

  async buildAuthorizeUrl(provider, next) {
    const state = randomString(32);
    const nonce = randomString(24);
    const verifier = randomString(64);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    this.ssoStates.set(state, { providerId: provider.id, verifier, nonce, next: next || '/', createdAt: Date.now() });

    const redirectUri = this.redirectUri(provider);
    let authorizeUrl;
    let scope = provider.scope || '';
    let clientId = provider.client_id;

    if (provider.type === 'oidc') {
      const meta = await this.discovery(provider);
      authorizeUrl = meta.authorization_endpoint;
      scope = scope || 'openid profile email';
    } else if (provider.type === 'feishu') {
      authorizeUrl = provider.authorize_url || 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
    } else if (provider.type === 'dingtalk') {
      authorizeUrl = provider.authorize_url || 'https://login.dingtalk.com/oauth2/auth';
    } else {
      authorizeUrl = provider.authorize_url;
      if (!authorizeUrl) throw new GatewayError('SSO authorize_url is not configured', { status: 500, type: 'gateway_error', code: 'sso_not_configured' });
    }

    const url = new URL(authorizeUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    if (scope) url.searchParams.set('scope', scope);
    if (provider.type === 'dingtalk') url.searchParams.set('prompt', 'consent');
    if (provider.type === 'oidc' || provider.type === 'oauth2') {
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('nonce', nonce);
    }
    return url.toString();
  }

  async exchangeCode(provider, code, state) {
    const entry = this.ssoStates.get(state);
    if (!entry || entry.providerId !== provider.id || Date.now() - entry.createdAt > 10 * 60 * 1000) {
      throw new GatewayError('Invalid or expired SSO state. Please sign in again.', { status: 400, type: 'authentication_error', code: 'invalid_sso_state' });
    }
    this.ssoStates.delete(state);
    const redirectUri = this.redirectUri(provider);
    const verifier = entry.verifier;

    if (provider.type === 'feishu') {
      const tokenUrl = provider.token_url || 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
      const { res, json } = await jsonFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: provider.client_id,
          client_secret: provider.client_secret,
          code,
          redirect_uri: redirectUri,
        }),
      }, 15000);
      if (!res.ok || !json?.access_token) throw new GatewayError(`Feishu token exchange failed: ${json?.error_description || json?.msg || res.status}`, { status: 502, type: 'authentication_error', code: 'sso_token_failed' });
      const info = await jsonFetch(provider.userinfo_url || 'https://open.feishu.cn/open-apis/authen/v1/user_info', {
        headers: { Authorization: `Bearer ${json.access_token}` },
      }, 10000);
      const data = info.json?.data || info.json || {};
      const email = data.enterprise_email || data.email || '';
      return {
        provider: provider.id,
        sub: textOf(data.open_id || data.union_id || data.user_id),
        email,
        name: textOf(data.name || data.en_name || email),
        raw: data,
      };
    }

    if (provider.type === 'dingtalk') {
      const tokenUrl = provider.token_url || 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken';
      const { res, json } = await jsonFetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: provider.client_id,
          clientSecret: provider.client_secret,
          code,
          grantType: 'authorization_code',
        }),
      }, 15000);
      if (!res.ok || !json?.accessToken) throw new GatewayError(`DingTalk token exchange failed: ${json?.message || res.status}`, { status: 502, type: 'authentication_error', code: 'sso_token_failed' });
      const info = await jsonFetch(provider.userinfo_url || 'https://api.dingtalk.com/v1.0/contact/users/me', {
        headers: { 'x-acs-dingtalk-access-token': json.accessToken },
      }, 10000);
      const data = info.json || {};
      const email = data.email || '';
      return {
        provider: provider.id,
        sub: textOf(data.unionId || data.openId),
        email,
        name: textOf(data.nick || data.name || email),
        raw: data,
      };
    }

    let tokenUrl;
    let userinfoUrl;
    let issuer = provider.issuer;
    if (provider.type === 'oidc') {
      const meta = await this.discovery(provider);
      tokenUrl = meta.token_endpoint;
      userinfoUrl = meta.userinfo_endpoint;
      if (provider.issuer) issuer = meta.issuer || provider.issuer;
    } else {
      tokenUrl = provider.token_url;
      userinfoUrl = provider.userinfo_url;
    }
    if (!tokenUrl) throw new GatewayError('SSO token_url is not configured', { status: 500, type: 'gateway_error', code: 'sso_not_configured' });

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: provider.client_id,
      code_verifier: verifier,
    });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (provider.client_secret) {
      headers.Authorization = `Basic ${Buffer.from(`${provider.client_id}:${provider.client_secret}`).toString('base64')}`;
    }
    const tokenRes = await jsonFetch(tokenUrl, { method: 'POST', headers, body: form.toString() }, 15000);
    if (!tokenRes.res.ok || !tokenRes.json?.access_token) {
      throw new GatewayError(`SSO token exchange failed: ${tokenRes.json?.error_description || tokenRes.json?.error || tokenRes.res.status}`, { status: 502, type: 'authentication_error', code: 'sso_token_failed' });
    }
    const tokens = tokenRes.json;

    let claims = null;
    if (provider.type === 'oidc' && tokens.id_token) {
      const meta = await this.discovery(provider);
      const jwks = await jsonFetch(meta.jwks_uri, {}, 10000);
      if (!jwks.res.ok || !jwks.json) throw new GatewayError('Failed to load SSO JWKS', { status: 502, type: 'gateway_error', code: 'sso_jwks_failed' });
      claims = verifyJwt(tokens.id_token, jwks.json, { issuer, audience: provider.client_id, nonce: entry.nonce });
    }
    if (!claims && userinfoUrl) {
      const info = await jsonFetch(userinfoUrl, { headers: { Authorization: `Bearer ${tokens.access_token}` } }, 10000);
      if (!info.res.ok || !info.json) throw new GatewayError(`SSO userinfo request failed (${info.res.status})`, { status: 502, type: 'authentication_error', code: 'sso_userinfo_failed' });
      claims = info.json;
    }
    if (!claims) throw new GatewayError('SSO did not return user information', { status: 502, type: 'authentication_error', code: 'sso_userinfo_failed' });

    const email = textOf(getPath(claims, provider.email_field || 'email') || getPath(claims, 'preferred_username'));
    const sub = textOf(getPath(claims, provider.id_field || 'sub') || claims.sub);
    const name = textOf(getPath(claims, provider.name_field || 'name') || email || sub);
    return { provider: provider.id, sub, email, name, raw: claims };
  }

  async provisionSsoUser(profile) {
    const autoCreate = this.settings.getBool('sso.auto_create', true);
    let user = this.db.get('SELECT * FROM users WHERE sso_provider = ? AND sso_sub = ?', profile.provider, profile.sub);
    if (!user && profile.email) {
      user = this.db.get('SELECT * FROM users WHERE lower(email) = ?', profile.email.toLowerCase());
      if (user && !user.sso_sub) {
        this.db.run('UPDATE users SET sso_provider = ?, sso_sub = ?, auth_source = ? , updated_at = ? WHERE id = ?',
          profile.provider, profile.sub, 'sso', Date.now(), user.id);
      }
    }
    if (!user) {
      if (!autoCreate) {
        throw forbidden('Your SSO account is not provisioned. Please contact an administrator.', 'user_not_provisioned');
      }
      if (!profile.email) profile.email = `${profile.provider}-${profile.sub}@sso.local`;
      const defaultRole = this.settings.get('sso.default_role', 'APP_USER');
      const orgId = this.settings.get('sso.default_org_id', '') || this.db.get('SELECT id FROM orgs ORDER BY created_at ASC LIMIT 1')?.id;
      if (!orgId) throw new GatewayError('No organization is configured for SSO users', { status: 500, type: 'gateway_error', code: 'no_default_org' });
      const id = randomId('usr_');
      const ts = Date.now();
      this.db.run(
        `INSERT INTO users (id, email, name, role, org_id, status, password_hash, auth_source, sso_provider, sso_sub,
          monthly_quota_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', NULL, 'sso', ?, ?, 0, ?, ?)`,
        id, profile.email, profile.name || profile.email, defaultRole, orgId, profile.provider, profile.sub, ts, ts,
      );
      user = this.db.get('SELECT * FROM users WHERE id = ?', id);
      logger.info('sso user auto-provisioned', { email: profile.email, provider: profile.provider });
    }
    if (user.status !== 'active') throw forbidden('This account has been frozen', 'account_frozen');
    this.db.run('UPDATE users SET last_login_at = ? WHERE id = ?', Date.now(), user.id);
    user = this.db.get('SELECT * FROM users WHERE id = ?', user.id);
    delete user.password_hash;
    return user;
  }

  async ssoCallback(providerId, code, state, ip) {
    const provider = this.getProvider(providerId);
    const profile = await this.exchangeCode(provider, code, state);
    const user = await this.provisionSsoUser(profile);
    writeAudit(this.db, { actor: user, action: 'auth.sso.success', targetType: 'user', targetId: user.id, detail: { provider: providerId }, ip });
    return { user, next: '/' };
  }

  async changePassword(userId, oldPassword, newPassword) {
    const user = this.db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) throw badRequest('User not found', 'user_not_found');
    if (!user.password_hash) throw badRequest('This account is managed by SSO and has no local password', 'sso_account');
    if (!(await verifyPassword(String(oldPassword || ''), user.password_hash))) {
      throw unauthorized('Current password is incorrect', 'invalid_password');
    }
    const hash = await hashPassword(String(newPassword));
    this.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, Date.now(), userId);
    writeAudit(this.db, { actor: user, action: 'auth.password.changed', targetType: 'user', targetId: userId });
  }
}
