import net from 'node:net';
import { GatewayError } from './errors.js';

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((seg) => {
            if (seg.startsWith(':')) {
              keys.push(seg.slice(1));
              return '([^/]+)';
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '/?$',
      'i',
    );
    this.routes.push({ method: method.toUpperCase(), regex, keys, handler });
  }

  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method.toUpperCase() && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {};
      route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
      return { handler: route.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

export async function readRawBody(req, limitBytes = 32 * 1024 * 1024) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > limitBytes) {
    throw new GatewayError('Request body exceeds the size limit', { status: 413, type: 'invalid_request_error', code: 'payload_too_large' });
  }
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      reject(err);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        fail(new GatewayError('Request body exceeds the size limit', { status: 413, type: 'invalid_request_error', code: 'payload_too_large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    const onError = (err) => fail(err);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export async function readJson(req, limitBytes) {
  const raw = await readRawBody(req, limitBytes);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new GatewayError('Request body is not valid JSON', { status: 400, type: 'invalid_request_error', code: 'invalid_json' });
  }
}

export function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  if (res.writableEnded) return;
  const body = Buffer.from(String(text));
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, ...headers });
  res.end(body);
}

export function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
}

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

export function serializeCookie(name, value, { maxAge, path = '/', httpOnly = true, sameSite = 'Lax', secure = false } = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (httpOnly) cookie += '; HttpOnly';
  if (secure) cookie += '; Secure';
  if (maxAge !== undefined) cookie += `; Max-Age=${maxAge}`;
  return cookie;
}

export function clearCookie(name, path = '/') {
  return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function getClientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return req.socket.remoteAddress || '';
}

export function normalizeIp(ip) {
  if (!ip) return '';
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip.split('%')[0];
}

export function ipMatchesCidr(ip, cidr) {
  ip = normalizeIp(ip);
  if (!ip) return false;
  const rule = String(cidr).trim();
  if (!rule) return false;
  if (rule === '*') return true;
  if (!rule.includes('/')) return normalizeIp(rule) === ip;

  const [network, bitsRaw] = rule.split('/');
  const version = net.isIP(network);
  if (!version || net.isIP(ip) !== version) return false;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0) return false;

  const toBig = (addr) => {
    if (version === 4) {
      const parts = addr.split('.').map(Number);
      return (BigInt(parts[0]) << 24n) | (BigInt(parts[1]) << 16n) | (BigInt(parts[2]) << 8n) | BigInt(parts[3]);
    }
    const [head, tail = ''] = addr.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const fill = 8 - headParts.length - tailParts.length;
    const full = [...headParts, ...Array(Math.max(0, fill)).fill('0'), ...tailParts];
    let value = 0n;
    for (const part of full) value = (value << 16n) | BigInt(parseInt(part || '0', 16));
    return value;
  };

  try {
    const maxBits = version === 4 ? 32 : 128;
    if (bits > maxBits) return false;
    const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(maxBits - bits);
    return (toBig(ip) & mask) === (toBig(network) & mask);
  } catch {
    return false;
  }
}

export function matchesAnyIp(ip, whitelist) {
  if (!Array.isArray(whitelist) || whitelist.length === 0) return true;
  return whitelist.some((cidr) => ipMatchesCidr(ip, cidr));
}

export function setCommonHeaders(res, requestId) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (requestId) res.setHeader('X-Request-Id', requestId);
}

export function startSse(res, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extraHeaders,
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function parseBasicAuth(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

export async function jsonFetch(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { res, text, json };
  } finally {
    clearTimeout(timer);
  }
}
