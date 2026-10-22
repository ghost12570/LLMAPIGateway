import { GatewayError, forbidden } from '../util/errors.js';
import { getClientIp } from '../util/http.js';
import { writeAudit } from '../services/audit.js';
import { descendantOrgIds } from '../services/users.js';

export const READ_ROLES = ['SUPER_ADMIN', 'ORG_ADMIN', 'AUDITOR'];
export const WRITE_ROLES = ['SUPER_ADMIN', 'ORG_ADMIN'];
export const SUPER_ONLY = ['SUPER_ADMIN'];

export function requireAdmin(app, req, { roles = READ_ROLES, write = false } = {}) {
  const session = app.auth.requireUser(req);
  if (!roles.includes(session.user.role)) {
    throw forbidden('You do not have permission to perform this action', 'permission_denied');
  }
  if (write && session.user.role === 'AUDITOR') {
    throw forbidden('Auditor accounts are read-only', 'read_only_role');
  }
  session._ip = getClientIp(req, app.config.trustProxy);
  return session;
}

export function orgScope(app, session) {
  if (session.user.role !== 'ORG_ADMIN') return null;
  return descendantOrgIds(app.db, session.user.org_id);
}

export function inScope(app, session, orgId) {
  const scope = orgScope(app, session);
  return !scope || scope.includes(orgId);
}

export function scopeClause(scope, column = 'org_id') {
  if (!scope) return { sql: '', params: [] };
  if (!scope.length) return { sql: ' AND 1=0', params: [] };
  return { sql: ` AND ${column} IN (${scope.map(() => '?').join(',')})`, params: [...scope] };
}

export function ipOf(app, req) {
  return getClientIp(req, app.config.trustProxy);
}

export function auditAs(app, session, action, { targetType, targetId, detail } = {}) {
  writeAudit(app.db, {
    actor: session?.user,
    action,
    targetType,
    targetId,
    detail,
    ip: session?._ip,
  });
}

export function requireString(value, name, { min = 1, max = 500 } = {}) {
  if (typeof value !== 'string') throw badInput(`${name} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length < min) throw badInput(`${name} is required`);
  if (trimmed.length > max) throw badInput(`${name} is too long (max ${max})`);
  return trimmed;
}

export function badInput(message) {
  return new GatewayError(message, { status: 400, type: 'invalid_request_error', code: 'invalid_request' });
}

export function requireNumber(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw badInput(`${name} must be a number between ${min} and ${max}`);
  }
  return n;
}

export function optionalBoolean(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw badInput(`${name} must be a boolean`);
  return value;
}

export function parseJsonField(value, name, fallback) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    if (!value.trim()) return fallback;
    try { return JSON.parse(value); } catch { throw badInput(`${name} must be valid JSON`); }
  }
  throw badInput(`${name} is invalid`);
}

export function ensureObject(value, name) {
  if (value === undefined) return undefined;
  const parsed = parseJsonField(value, name, {});
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badInput(`${name} must be a JSON object`);
  return parsed;
}

export function ensureStringArray(value, name, { max = 100 } = {}) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw badInput(`${name} must be an array`);
  if (value.length > max) throw badInput(`${name} has too many entries (max ${max})`);
  return value.map((v) => {
    if (typeof v !== 'string' || !v.trim()) throw badInput(`${name} must contain non-empty strings`);
    return v.trim().slice(0, 200);
  });
}

export function notFound(message = 'Resource not found') {
  return new GatewayError(message, { status: 404, type: 'invalid_request_error', code: 'not_found' });
}

export function conflict(message) {
  return new GatewayError(message, { status: 409, type: 'invalid_request_error', code: 'conflict' });
}

export function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const host = req.headers.host;
  const allowed = new Set();
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }
  try {
    const pub = new URL(process.env.PUBLIC_BASE_URL || '');
    allowed.add(pub.origin);
  } catch { /* ignore */ }
  if (!allowed.has(origin)) {
    throw new GatewayError('Cross-origin request blocked', { status: 403, type: 'permission_denied', code: 'csrf_blocked' });
  }
}
