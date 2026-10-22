import { getAdapter } from '../providers/index.js';
import { getChannel, getChannelModels } from '../services/channels.js';
import { logger } from '../util/logger.js';

export class HealthService {
  constructor({ db, settings, circuits, routing }) {
    this.db = db;
    this.settings = settings;
    this.circuits = circuits;
    this.routing = routing;
    this.states = new Map();
    this.running = false;
    this.timer = setInterval(() => this.runAll(), this.settings.getNumber('health.interval_ms', 30000));
    this.timer.unref?.();
    const initial = setTimeout(() => this.runAll(), 1200);
    initial.unref?.();
  }

  snapshot(channelId) {
    return this.states.get(channelId) || { status: 'unknown', latency_ms: null, checked_at: null, message: '尚未探测' };
  }

  async probe(channelId, { manual = false } = {}) {
    const channel = getChannel(this.db, channelId);
    if (!channel) throw new Error('Channel not found');
    const startedAt = Date.now();
    const pool = this.routing.loadKeyPool(channelId);
    if (!pool.keys.length) {
      const state = { status: 'error', latency_ms: null, checked_at: Date.now(), message: '渠道未配置可用的上游 Key' };
      this.states.set(channelId, state);
      return { ok: false, ...state };
    }
    const adapter = getAdapter(channel.provider);
    const mappings = getChannelModels(this.db, channelId);
    const upstreamModel = mappings.find((m) => m.enabled)?.upstream_model;
    let request;
    try {
      request = adapter.probe({ channel, apiKey: pool.keys[0].key, upstreamModel });
    } catch (err) {
      const state = { status: 'error', latency_ms: null, checked_at: Date.now(), message: `探测配置错误: ${err.message}` };
      this.states.set(channelId, state);
      return { ok: false, ...state };
    }
    try {
      const res = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(manual ? 15000 : 8000), redirect: 'follow' });
      let message = res.ok ? `HTTP ${res.status} OK` : `HTTP ${res.status}`;
      try {
        const text = (await res.text()).slice(0, 300);
        if (text && !res.ok) message = `HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`;
      } catch { /* ignore */ }
      const state = {
        status: res.ok ? 'healthy' : 'error',
        latency_ms: Date.now() - startedAt,
        checked_at: Date.now(),
        message,
        status_code: res.status,
        manual,
      };
      this.states.set(channelId, state);
      if (res.ok) this.circuits.onSuccess(channelId, state.latency_ms);
      return { ok: res.ok, ...state };
    } catch (err) {
      const state = {
        status: 'error',
        latency_ms: Date.now() - startedAt,
        checked_at: Date.now(),
        message: `连通性探测失败: ${err.cause?.code || err.message}`,
        status_code: 0,
        manual,
      };
      this.states.set(channelId, state);
      return { ok: false, ...state };
    }
  }

  async runAll() {
    if (this.running) return;
    this.running = true;
    try {
      const channels = this.db.all("SELECT id FROM channels WHERE status = 'enabled'");
      await Promise.all(channels.map((c) => this.probe(c.id).catch((err) => {
        logger.warn('health probe failed', { channelId: c.id, error: err.message });
      })));
    } finally {
      this.running = false;
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}
