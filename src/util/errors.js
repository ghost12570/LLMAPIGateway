export class GatewayError extends Error {
  constructor(message, { status = 500, type = 'server_error', code = 'internal_error', headers = {}, retryable = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.type = type;
    this.code = code;
    this.headers = headers;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.type,
        param: null,
        code: this.code,
      },
    };
  }
}

export function badRequest(message, code = 'invalid_request') {
  return new GatewayError(message, { status: 400, type: 'invalid_request_error', code });
}

export function unauthorized(message = 'Invalid API key provided', code = 'invalid_api_key') {
  return new GatewayError(message, { status: 401, type: 'authentication_error', code });
}

export function forbidden(message = 'You do not have permission to access this resource', code = 'permission_denied') {
  return new GatewayError(message, { status: 403, type: 'permission_denied', code });
}

export function quotaExceeded(message, retryAfter) {
  return new GatewayError(message, {
    status: 429,
    type: 'rate_limit_error',
    code: 'quota_exceeded',
    headers: retryAfter ? { 'Retry-After': String(retryAfter) } : {},
  });
}

export function rateLimited(message, retryAfter = 3) {
  return new GatewayError(message, {
    status: 429,
    type: 'rate_limit_error',
    code: 'rate_limit_exceeded',
    headers: { 'Retry-After': String(retryAfter) },
  });
}

export function noChannel(message = 'No available upstream channel for the requested model') {
  return new GatewayError(message, { status: 503, type: 'server_error', code: 'no_available_channel', retryable: true });
}

export function upstreamTimeout(message = 'Upstream request timed out') {
  return new GatewayError(message, { status: 504, type: 'server_error', code: 'gateway_timeout', retryable: true });
}

export function upstreamFailure(message = 'Upstream connection failed') {
  return new GatewayError(message, { status: 502, type: 'server_error', code: 'upstream_connection_failed', retryable: true });
}

export function contextLengthExceeded(message) {
  return new GatewayError(message, { status: 400, type: 'invalid_request_error', code: 'context_length_exceeded' });
}

/**
 * Map a raw upstream error response into a gateway error.
 * Never exposes upstream credentials; keeps the message actionable.
 */
export function mapUpstreamError(status, bodyText, provider) {
  const raw = String(bodyText || '').trim();
  let message = raw.slice(0, 1200);
  let code = 'upstream_error';
  let type = 'server_error';
  let outStatus = 502;

  try {
    const parsed = JSON.parse(raw);
    const e = parsed.error || parsed;
    if (typeof e === 'string') message = e;
    else message = e.message || e.error_msg || e.msg || e.code || message;
    if (e.code) code = String(e.code);
    if (e.type) type = /rate/i.test(e.type) ? 'rate_limit_error' : /auth/i.test(e.type) ? 'authentication_error' : type;
  } catch {
    /* keep raw text */
  }
  if (!message) message = `Upstream ${provider || 'provider'} returned HTTP ${status}`;

  if (status === 429) {
    outStatus = 429;
    type = 'upstream_error';
    code = 'upstream_rate_limit';
  } else if (status === 408 || status === 504) {
    outStatus = 504;
    code = 'gateway_timeout';
  } else if (status === 400 || status === 413 || status === 422) {
    outStatus = 400;
    type = 'invalid_request_error';
    if (/context length|maximum context|too many tokens|prompt is too long|input is too long/i.test(message)) {
      code = 'context_length_exceeded';
    } else {
      code = code === 'upstream_error' ? 'invalid_request' : code;
    }
  } else if (status === 401 || status === 403) {
    outStatus = 502;
    type = 'upstream_error';
    code = 'upstream_auth_error';
    message = 'Upstream provider rejected the channel credentials. Please contact the platform administrator.';
  } else if (status >= 500) {
    outStatus = 502;
    type = 'server_error';
    code = 'upstream_connection_failed';
  }

  return new GatewayError(message, { status: outStatus, type, code, retryable: status === 429 || status >= 500 || status === 408 });
}

export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
