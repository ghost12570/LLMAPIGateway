import { logger } from '../util/logger.js';

const FAILURE_KINDS = new Set(['timeout', 'network', 'upstream_error', 'upstream_rate_limit', 'upstream_auth_error']);

export class CircuitBreakerService {
  constructor(settings) {
    this.settings = settings;
    this.channels = new Map();
    this.onStateChange = null;
  }

  get(id) {
    let state = this.channels.get(id);
    if (!state) {
      state = {
        state: 'closed',
        openedAt: null,
        consecutiveFailures: 0,
        window: [],
        trialActive: false,
        lastError: null,
        lastFailureAt: null,
        lastSuccessAt: null,
        totalSuccess: 0,
        totalFailure: 0,
        lastLatencyMs: null,
        latencyAvg: null,
      };
      this.channels.set(id, state);
    }
    return state;
  }

  get cooldown() { return this.settings.getNumber('circuit.cooldown_ms', 30000); }
  get failureThreshold() { return this.settings.getNumber('circuit.failure_threshold', 3); }
  get windowSize() { return this.settings.getNumber('circuit.window_size', 20); }
  get errorRate() { return this.settings.getNumber('circuit.error_rate', 0.25); }

  canAttempt(id) {
    const s = this.get(id);
    if (s.state === 'closed') return true;
    if (s.state === 'open') {
      if (Date.now() - s.openedAt >= this.cooldown) {
        s.state = 'half_open';
        s.trialActive = false;
        logger.info('circuit half-open', { channelId: id });
        return true;
      }
      return false;
    }
    if (s.state === 'half_open') return !s.trialActive;
    return true;
  }

  markTrial(id) {
    const s = this.get(id);
    if (s.state === 'half_open') s.trialActive = true;
  }

  /** Non-mutating availability check, safe for read-only model listings. */
  peekAvailable(id) {
    const s = this.get(id);
    if (s.state === 'closed') return true;
    if (s.state === 'open') return Date.now() - s.openedAt >= this.cooldown;
    return !s.trialActive;
  }

  setOpen(id, reason) {
    const s = this.get(id);
    const wasOpen = s.state === 'open';
    s.state = 'open';
    s.openedAt = Date.now();
    s.trialActive = false;
    s.lastError = reason;
    logger.warn('circuit opened', { channelId: id, reason });
    if (!wasOpen && this.onStateChange) {
      this.onStateChange({ channelId: id, state: 'open', reason });
    }
  }

  onSuccess(id, latencyMs) {
    const s = this.get(id);
    const recovered = s.state !== 'closed';
    s.totalSuccess++;
    s.lastSuccessAt = Date.now();
    s.consecutiveFailures = 0;
    s.window.push({ ts: Date.now(), ok: true });
    this.trimWindow(s);
    s.state = 'closed';
    s.openedAt = null;
    s.trialActive = false;
    s.lastError = null;
    if (latencyMs !== undefined) {
      s.lastLatencyMs = latencyMs;
      s.latencyAvg = s.latencyAvg === null ? latencyMs : Math.round(s.latencyAvg * 0.7 + latencyMs * 0.3);
    }
    if (recovered) {
      logger.info('circuit recovered', { channelId: id });
      if (this.onStateChange) this.onStateChange({ channelId: id, state: 'closed' });
    }
  }

  onFailure(id, kind, message, latencyMs) {
    const s = this.get(id);
    s.totalFailure++;
    s.lastFailureAt = Date.now();
    s.lastError = message || kind;
    if (latencyMs !== undefined) s.lastLatencyMs = latencyMs;
    const failure = FAILURE_KINDS.has(kind);
    s.window.push({ ts: Date.now(), ok: !failure });
    this.trimWindow(s);
    if (failure) s.consecutiveFailures++;
    else s.consecutiveFailures = 0;

    if (s.state === 'half_open') {
      this.setOpen(id, message || kind);
      return;
    }
    if (s.state === 'closed') {
      const failures = s.window.filter((w) => !w.ok).length;
      const rate = s.window.length ? failures / s.window.length : 0;
      if (
        (failure && s.consecutiveFailures >= this.failureThreshold) ||
        (s.window.length >= Math.min(8, this.windowSize) && rate > this.errorRate)
      ) {
        this.setOpen(id, message || kind);
      }
    }
  }

  trimWindow(s) {
    const size = this.windowSize;
    if (s.window.length > size) s.window.splice(0, s.window.length - size);
  }

  reset(id) {
    const s = this.get(id);
    Object.assign(s, {
      state: 'closed', openedAt: null, consecutiveFailures: 0, window: [], trialActive: false, lastError: null,
    });
    logger.info('circuit manually reset', { channelId: id });
  }

  forget(id) {
    this.channels.delete(id);
  }

  snapshot(id) {
    const s = this.get(id);
    return {
      state: s.state,
      opened_at: s.openedAt,
      cooldown_ms: this.cooldown,
      consecutive_failures: s.consecutiveFailures,
      failure_rate: s.window.length ? s.window.filter((w) => !w.ok).length / s.window.length : 0,
      last_error: s.lastError,
      last_failure_at: s.lastFailureAt,
      last_success_at: s.lastSuccessAt,
      total_success: s.totalSuccess,
      total_failure: s.totalFailure,
      last_latency_ms: s.lastLatencyMs,
      latency_avg_ms: s.latencyAvg,
    };
  }
}
