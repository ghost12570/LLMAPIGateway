import { parseApiKey } from './keys.js';
import { matchesAnyIp } from '../util/http.js';
import { forbidden, unauthorized } from '../util/errors.js';
import { sha256Hex, hmacHex } from '../util/crypto.js';

export class KeyAuthService {
  constructor(db, { masterSecret, settings }) {
    this.db = db;
    this.masterSecret = masterSecret;
    this.settings = settings;
    this.cache = new Map();
    this.lastUsedWrites = new Map();
    this.cacheTtlMs = 15000;
    this.pepper = sha256Hex(`${masterSecret}:apikey-lookup`);
  }

  invalidate(keyId) {
    for (const [hash, entry] of this.cache) {
      if (entry.ctx.key.id === keyId) this.cache.delete(hash);
    }
  }

  invalidateUser(userId) {
    for (const [hash, entry] of this.cache) {
      if (entry.ctx.user.id === userId) this.cache.delete(hash);
    }
  }

  invalidateAll() {
    this.cache.clear();
  }

  authenticate(req, requestIp) {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!match) {
      throw unauthorized('Missing bearer token. Provide an API key via Authorization: Bearer sk-corp-...');
    }
    const plaintext = match[1].trim();
    if (!plaintext.startsWith('sk-corp-') || plaintext.length < 16) {
      throw unauthorized('Invalid API key provided');
    }
    const entry = this.getOrLoad(plaintext);
    if (!entry) throw unauthorized('Invalid API key provided');
    const ctx = entry.ctx;
    if (ctx.key.status !== 'active') throw unauthorized('This API key has been disabled or revoked');
    if (ctx.key.expires_at && ctx.key.expires_at < Date.now()) throw unauthorized('This API key has expired');
    if (ctx.user.status !== 'active') throw forbidden('The owning user account is frozen', 'account_frozen');
    if (ctx.org?.status && ctx.org.status !== 'active') throw forbidden('The owning organization is inactive', 'org_inactive');
    if (ctx.key.ip_whitelist?.length && !matchesAnyIp(requestIp, ctx.key.ip_whitelist)) {
      throw forbidden(`IP address ${requestIp || 'unknown'} is not in this key's whitelist`, 'ip_not_allowed');
    }
    this.touchKey(ctx.key.id);
    return { ...ctx, ip: requestIp, source: 'api' };
  }

  playgroundContext(user, org, ip) {
    return {
      key: {
        id: `playground_${user.id}`,
        name: 'Playground',
        tags: ['PLAYGROUND'],
        allowed_models: null,
        ip_whitelist: null,
        monthly_limit_usd: 0,
        total_limit_usd: 0,
        qps_limit: null,
        tpm_limit: null,
        status: 'active',
        expires_at: null,
      },
      user,
      org,
      quotaOrg: org,
      ip,
      source: 'playground',
      rateLimitId: `user:${user.id}`,
      playground: true,
    };
  }

  getOrLoad(plaintext) {
    const lookupHash = hmacHex(this.pepper, plaintext);
    const cached = this.cache.get(lookupHash);
    if (cached && cached.expires > Date.now()) return cached;

    const row = this.db.get(
      `SELECT k.*, u.name AS u_name, u.email AS u_email, u.role AS u_role, u.status AS u_status,
              u.monthly_quota_usd AS u_quota, u.org_id AS u_org,
              o.name AS o_name, o.monthly_quota_usd AS o_quota, o.status AS o_status, o.path AS o_path
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
       JOIN orgs o ON o.id = u.org_id
       WHERE k.lookup_hash = ?`,
      lookupHash,
    );
    if (!row) return null;
    const key = parseApiKey(row);
    const user = {
      id: row.user_id,
      name: row.u_name,
      email: row.u_email,
      role: row.u_role,
      status: row.u_status,
      org_id: row.u_org,
      monthly_quota_usd: row.u_quota,
    };
    const org = {
      id: row.u_org,
      name: row.o_name,
      status: row.o_status,
      monthly_quota_usd: row.o_quota,
      path: row.o_path,
    };
    const ctx = { key, user, org, quotaOrg: org, rateLimitId: `key:${key.id}` };
    const entry = { ctx, expires: Date.now() + this.cacheTtlMs };
    this.cache.set(lookupHash, entry);
    return entry;
  }

  touchKey(keyId) {
    const last = this.lastUsedWrites.get(keyId) || 0;
    const t = Date.now();
    if (t - last < 60000) return;
    this.lastUsedWrites.set(keyId, t);
    this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', t, keyId);
  }
}
