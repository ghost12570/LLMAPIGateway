import {
  generateApiKey, maskApiKey, hashKeyWithSalt, hmacHex, randomId, sha256Hex,
} from '../util/crypto.js';

export function parseApiKey(row) {
  if (!row) return null;
  let tags = [];
  let allowed = null;
  let ips = null;
  try { tags = JSON.parse(row.tags || '[]'); } catch { /* ignore */ }
  try { allowed = row.allowed_models ? JSON.parse(row.allowed_models) : null; } catch { /* ignore */ }
  try { ips = row.ip_whitelist ? JSON.parse(row.ip_whitelist) : null; } catch { /* ignore */ }
  const out = {
    ...row,
    tags,
    allowed_models: allowed,
    ip_whitelist: ips,
  };
  delete out.key_hash;
  delete out.lookup_hash;
  return out;
}

export function createApiKey(db, masterSecret, {
  user,
  name,
  expiresAt = null,
  monthlyLimitUsd = 0,
  totalLimitUsd = 0,
  qpsLimit = null,
  tpmLimit = null,
  allowedModels = null,
  ipWhitelist = null,
  tags = [],
}) {
  const plaintext = generateApiKey();
  const pepper = sha256Hex(`${masterSecret}:apikey-lookup`);
  const salt = randomId('');
  const lookupHash = hmacHex(pepper, plaintext);
  const keyHash = hashKeyWithSalt(salt, plaintext);
  const masked = maskApiKey(plaintext);
  const id = randomId('key_');
  const ts = Date.now();
  db.run(
    `INSERT INTO api_keys (id, user_id, org_id, name, key_hash, lookup_hash, masked, status, expires_at,
      monthly_limit_usd, total_limit_usd, qps_limit, tpm_limit, allowed_models, ip_whitelist, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, user.id, user.org_id, name, keyHash, lookupHash, masked, expiresAt,
    Number(monthlyLimitUsd) || 0, Number(totalLimitUsd) || 0, qpsLimit || null, tpmLimit || null,
    Array.isArray(allowedModels) && allowedModels.length ? JSON.stringify(allowedModels) : null,
    Array.isArray(ipWhitelist) && ipWhitelist.length ? JSON.stringify(ipWhitelist) : null,
    JSON.stringify(Array.isArray(tags) ? tags : []), ts, ts,
  );
  return { plaintext, record: parseApiKey(db.get('SELECT * FROM api_keys WHERE id = ?', id)) };
}

export function listApiKeys(db, { orgIds = null, userId = null, status, q, page = 1, page_size = 50 } = {}) {
  const where = [];
  const params = [];
  if (Array.isArray(orgIds)) {
    if (!orgIds.length) where.push('1=0');
    else { where.push(`k.org_id IN (${orgIds.map(() => '?').join(',')})`); params.push(...orgIds); }
  }
  if (userId) { where.push('k.user_id = ?'); params.push(userId); }
  if (status) { where.push('k.status = ?'); params.push(status); }
  if (q) {
    where.push('(k.name LIKE ? OR k.masked LIKE ? OR u.email LIKE ? OR u.name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS c FROM api_keys k JOIN users u ON u.id = k.user_id ${clause}`, ...params).c;
  const size = Math.min(200, Math.max(1, Number(page_size) || 50));
  const p = Math.max(1, Number(page) || 1);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const items = db.all(
    `SELECT k.*, u.name AS user_name, u.email AS user_email,
       (SELECT COALESCE(SUM(l.cost_usd), 0) FROM request_logs l WHERE l.key_id = k.id AND l.ts >= ?) AS month_spent_usd,
       (SELECT COALESCE(SUM(l.cost_usd), 0) FROM request_logs l WHERE l.key_id = k.id) AS total_spent_usd,
       (SELECT MAX(l.ts) FROM request_logs l WHERE l.key_id = k.id) AS last_request_at
     FROM api_keys k JOIN users u ON u.id = k.user_id
     ${clause} ORDER BY k.created_at DESC LIMIT ? OFFSET ?`,
    monthStart, ...params, size, (p - 1) * size,
  ).map(parseApiKey);
  return { items, total, page: p, page_size: size, pages: Math.max(1, Math.ceil(total / size)) };
}

export function apiKeyUsage(db, keyId) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const row = db.get(
    `SELECT COALESCE(SUM(cost_usd),0) AS month_cost, COALESCE(SUM(total_tokens),0) AS month_tokens,
            COUNT(*) AS month_requests
     FROM request_logs WHERE key_id = ? AND ts >= ?`,
    keyId, monthStart,
  );
  const total = db.get(
    'SELECT COALESCE(SUM(cost_usd),0) AS total_cost, COUNT(*) AS total_requests FROM request_logs WHERE key_id = ?',
    keyId,
  );
  return { ...row, ...total };
}
