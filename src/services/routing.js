import { badRequest, noChannel } from '../util/errors.js';
import { parseChannel } from './channels.js';
import { estimateChatPromptTokens } from '../util/tokenizer.js';
import { decryptSecret } from '../util/crypto.js';

const OPENAI_COMPATIBLE = new Set(['openai', 'azure', 'deepseek', 'dashscope', 'custom']);

export class RoutingService {
  constructor(db, { settings, circuits, masterSecret }) {
    this.db = db;
    this.settings = settings;
    this.circuits = circuits;
    this.masterSecret = masterSecret;
    this.snapshot = null;
    this.snapshotAt = 0;
    this.keyPools = new Map();
    this.slots = new Map();
    this.keyTouch = new Map();
  }

  invalidate() {
    this.snapshot = null;
    this.snapshotAt = 0;
    this.keyPools.clear();
  }

  invalidateKeys(channelId) {
    if (channelId) this.keyPools.delete(channelId);
    else this.keyPools.clear();
  }

  loadSnapshot() {
    const now = Date.now();
    if (this.snapshot && now - this.snapshotAt < 10000) return this.snapshot;
    const channels = new Map();
    for (const row of this.db.all("SELECT * FROM channels WHERE status = 'enabled'")) {
      const channel = parseChannel(row);
      channels.set(channel.id, channel);
    }
    const mappings = new Map();
    for (const row of this.db.all('SELECT * FROM channel_models WHERE enabled = 1')) {
      if (!channels.has(row.channel_id)) continue;
      if (!mappings.has(row.model_alias)) mappings.set(row.model_alias, []);
      mappings.get(row.model_alias).push({ ...row, channel: channels.get(row.channel_id) });
    }
    const models = new Map();
    for (const row of this.db.all('SELECT * FROM models')) {
      let capabilities = [];
      let fallback = [];
      try { capabilities = JSON.parse(row.capabilities || '[]'); } catch { /* ignore */ }
      try { fallback = JSON.parse(row.fallback_chain || '[]'); } catch { /* ignore */ }
      models.set(row.alias, { ...row, capabilities, fallback_chain: fallback });
    }
    this.snapshot = { channels, mappings, models };
    this.snapshotAt = now;
    return this.snapshot;
  }

  loadKeyPool(channelId) {
    const cached = this.keyPools.get(channelId);
    if (cached && Date.now() - cached.loadedAt < 60000) return cached;
    const rows = this.db.all("SELECT * FROM channel_keys WHERE channel_id = ? AND status = 'active' ORDER BY created_at ASC", channelId);
    const keys = [];
    for (const row of rows) {
      try {
        keys.push({ id: row.id, key: decryptSecret(this.masterSecret, row.encrypted_key) });
      } catch {
        /* skip undecryptable keys */
      }
    }
    const pool = { keys, idx: 0, loadedAt: Date.now() };
    this.keyPools.set(channelId, pool);
    return pool;
  }

  nextKey(channelId) {
    const pool = this.loadKeyPool(channelId);
    if (!pool.keys.length) return null;
    const key = pool.keys[pool.idx % pool.keys.length];
    pool.idx = (pool.idx + 1) % Math.max(1, pool.keys.length);
    const last = this.keyTouch.get(key.id) || 0;
    if (Date.now() - last > 60000) {
      this.keyTouch.set(key.id, Date.now());
      this.db.run('UPDATE channel_keys SET last_used_at = ? WHERE id = ?', Date.now(), key.id);
    }
    return key;
  }

  slotAvailable(channel) {
    const limit = Number(channel.concurrency_limit) || 0;
    if (!limit) return true;
    return (this.slots.get(channel.id) || 0) < limit;
  }

  acquireSlot(channelId) {
    this.slots.set(channelId, (this.slots.get(channelId) || 0) + 1);
  }

  releaseSlot(channelId) {
    const next = (this.slots.get(channelId) || 0) - 1;
    if (next > 0) this.slots.set(channelId, next);
    else this.slots.delete(channelId);
  }

  activeSlots(channelId) {
    return this.slots.get(channelId) || 0;
  }

  detectAutoGroup(body) {
    const messages = body.messages || [];
    const promptTokens = estimateChatPromptTokens(messages, body.tools);
    const text = messages.map((m) => {
      if (typeof m?.content === 'string') return m.content;
      if (Array.isArray(m?.content)) return m.content.map((p) => p?.text || '').join(' ');
      return '';
    }).join('\n');
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const codeish = /```|\b(function|class|const|let|import|SELECT|def |public |async |await)\b|代码|编程|debug|报错/i.test(text);
    const reasoningish = /推理|分析|证明|算法|复杂度|为什么|step by step|reason|prove|math|逻辑/i.test(text);
    if (codeish) return 'coding';
    if (hasTools) return 'flagship';
    if (reasoningish || promptTokens > 4000) return 'reasoning';
    if (promptTokens <= 500) return 'fast';
    return 'flagship';
  }

  expandFallbacks(alias, models, seen = new Set()) {
    if (seen.has(alias)) return [];
    seen.add(alias);
    const model = models.get(alias);
    if (!model) return [];
    const out = [];
    for (const fb of model.fallback_chain || []) {
      if (!models.has(fb) || seen.has(fb)) continue;
      out.push(fb);
      out.push(...this.expandFallbacks(fb, models, seen));
    }
    return out;
  }

  resolveAliases(requested, body, models, { allowedModels, capability } = {}) {
    const model = models.get(requested);
    if (!model) throw badRequest(`The model '${requested}' does not exist or is not configured`, 'model_not_found');
    if (capability && !model.capabilities.includes(capability) && model.kind !== 'router') {
      throw badRequest(`The model '${requested}' does not support ${capability} requests`, 'model_capability_mismatch');
    }

    let primaries;
    if (model.kind === 'router') {
      const smart = this.settings.getJSON('smart_routes', {});
      const groups = smart.groups || {};
      const strategy = smart[requested]?.strategy || model.smart_group || 'auto';
      const groupsOrder = [];
      if (strategy === 'auto') groupsOrder.push(this.detectAutoGroup(body));
      else groupsOrder.push(strategy);
      for (const g of ['flagship', 'fast', 'coding', 'reasoning']) if (!groupsOrder.includes(g)) groupsOrder.push(g);
      primaries = [];
      for (const group of groupsOrder) {
        for (const alias of groups[group] || []) {
          if (!models.has(alias)) continue;
          if (allowedModels && !allowedModels.includes(alias)) continue;
          const target = models.get(alias);
          if (capability && !target.capabilities.includes(capability)) continue;
          if (!primaries.includes(alias)) primaries.push(alias);
        }
      }
      if (!primaries.length) throw badRequest(`No model is eligible for router '${requested}'`, 'no_eligible_model');
    } else {
      if (allowedModels && !allowedModels.includes(requested)) {
        throw badRequest(`This API key is not authorized to use model '${requested}'`, 'model_not_allowed');
      }
      primaries = [requested];
    }

    const aliases = [];
    const seen = new Set();
    for (const alias of primaries) {
      if (seen.has(alias)) continue;
      seen.add(alias);
      aliases.push(alias);
    }
    for (const alias of primaries) {
      for (const fb of this.expandFallbacks(alias, models)) {
        if (seen.has(fb)) continue;
        if (allowedModels && !allowedModels.includes(fb)) continue;
        const target = models.get(fb);
        if (capability && !target.capabilities.includes(capability)) continue;
        seen.add(fb);
        aliases.push(fb);
      }
    }
    return { model, aliases };
  }

  weightedOrder(items) {
    const pool = [...items];
    if (this.settings.get('routing.order_strategy', 'weighted') === 'latency') {
      return pool.sort((a, b) => {
        const la = this.circuits.snapshot(a.channel.id).latency_avg_ms;
        const lb = this.circuits.snapshot(b.channel.id).latency_avg_ms;
        return (la ?? Number.MAX_SAFE_INTEGER) - (lb ?? Number.MAX_SAFE_INTEGER);
      });
    }
    const out = [];
    while (pool.length) {
      const total = pool.reduce((sum, item) => sum + Math.max(1, Number(item.channel?.weight) || 1), 0);
      let pick = Math.random() * total;
      let idx = 0;
      for (; idx < pool.length; idx++) {
        pick -= Math.max(1, Number(pool[idx].channel?.weight) || 1);
        if (pick <= 0) break;
      }
      out.push(pool.splice(Math.min(idx, pool.length - 1), 1)[0]);
    }
    return out;
  }

  resolveCandidates({ requested, body, allowedModels, capability }) {
    const snap = this.loadSnapshot();
    const { model, aliases } = this.resolveAliases(requested, body, snap.models, { allowedModels, capability });
    const maxAttempts = Math.max(1, this.settings.getNumber('limits.max_attempts', 3));
    const candidates = [];
    const usedChannels = new Set();

    for (const alias of aliases) {
      const targetModel = snap.models.get(alias);
      const mappings = (snap.mappings.get(alias) || []).filter((m) => {
        if (capability === 'embedding' && !OPENAI_COMPATIBLE.has(m.channel.provider)) return false;
        if (usedChannels.has(m.channel.id)) return false;
        if (!this.circuits.canAttempt(m.channel.id)) return false;
        if (!this.slotAvailable(m.channel)) return false;
        return true;
      });
      const ordered = [];
      const priorities = [...new Set(mappings.map((m) => Number(m.channel.priority) || 5))].sort((a, b) => a - b);
      for (const priority of priorities) {
        ordered.push(...this.weightedOrder(mappings.filter((m) => Number(m.channel.priority) === priority)));
      }
      for (const mapping of ordered) {
        if (candidates.length >= maxAttempts * 2) break;
        if (usedChannels.has(mapping.channel.id)) continue;
        const key = this.nextKey(mapping.channel.id);
        if (!key) continue;
        usedChannels.add(mapping.channel.id);
        candidates.push({
          alias,
          targetModel,
          channel: mapping.channel,
          upstreamModel: mapping.upstream_model,
          key,
        });
      }
    }

    if (!candidates.length) {
      throw noChannel(`No healthy upstream channel is currently available for model '${requested}'. Please retry later.`);
    }
    return { requested, model, candidates: candidates.slice(0, maxAttempts), attemptsAllowed: maxAttempts };
  }

  modelStatus(alias) {
    const snap = this.loadSnapshot();
    const mappings = snap.mappings.get(alias) || [];
    const healthy = mappings.filter((m) => this.circuits.peekAvailable(m.channel.id) && this.loadKeyPool(m.channel.id).keys.length);
    return {
      available: healthy.length > 0,
      channel_count: mappings.length,
      healthy_channels: healthy.length,
    };
  }
}
