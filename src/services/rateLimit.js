const now = () => Date.now();

export class RateLimiter {
  constructor(settings) {
    this.settings = settings;
    this.qpsBuckets = new Map();
    this.tpmWindows = new Map();
    this.timer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.timer.unref?.();
  }

  limitForKey(key) {
    const defaultQps = this.settings.getNumber('limits.default_qps', 20) || 20;
    const defaultTpm = this.settings.getNumber('limits.default_tpm', 500000) || 500000;
    return {
      qps: Number(key?.qps_limit) > 0 ? Number(key.qps_limit) : defaultQps,
      tpm: Number(key?.tpm_limit) > 0 ? Number(key.tpm_limit) : defaultTpm,
    };
  }

  takeQps(id, limit) {
    const t = now();
    let bucket = this.qpsBuckets.get(id);
    if (!bucket) {
      bucket = { tokens: limit, last: t, limit };
      this.qpsBuckets.set(id, bucket);
    }
    bucket.limit = limit;
    const elapsed = Math.max(0, (t - bucket.last) / 1000);
    bucket.tokens = Math.min(limit, bucket.tokens + elapsed * limit);
    bucket.last = t;
    if (bucket.tokens < 1) {
      const retryAfter = Math.max(1, Math.ceil((1 - bucket.tokens) / limit));
      return { ok: false, retryAfter, limit };
    }
    bucket.tokens -= 1;
    return { ok: true, limit };
  }

  tpmWindow(id) {
    const t = now();
    let win = this.tpmWindows.get(id);
    if (!win) {
      win = { buckets: new Map(), total: 0 };
      this.tpmWindows.set(id, win);
    }
    const cutoff = t - 60000;
    for (const [sec, tokens] of win.buckets) {
      if (sec < cutoff / 1000) {
        win.total -= tokens;
        win.buckets.delete(sec);
      }
    }
    return win;
  }

  checkTpm(id, limit, estimatedTokens) {
    if (!limit || limit <= 0) return { ok: true };
    const win = this.tpmWindow(id);
    if (win.total + estimatedTokens > limit) {
      const oldest = Math.min(...[...win.buckets.keys()].map((s) => s * 1000));
      const waitMs = Number.isFinite(oldest) ? Math.max(1000, (oldest + 60000) - now()) : 60000;
      return { ok: false, retryAfter: Math.ceil(waitMs / 1000), limit };
    }
    return { ok: true };
  }

  check(id, key, estimatedTokens) {
    const { qps, tpm } = this.limitForKey(key);
    const qpsResult = this.takeQps(id, qps);
    if (!qpsResult.ok) {
      return { ok: false, reason: 'qps', retryAfter: qpsResult.retryAfter, qps, tpm };
    }
    const tpmResult = this.checkTpm(id, tpm, estimatedTokens);
    if (!tpmResult.ok) {
      return { ok: false, reason: 'tpm', retryAfter: tpmResult.retryAfter, qps, tpm };
    }
    return { ok: true, qps, tpm };
  }

  recordTokens(id, tokens) {
    if (!tokens || tokens <= 0) return;
    const win = this.tpmWindow(id);
    const sec = Math.floor(now() / 1000);
    win.buckets.set(sec, (win.buckets.get(sec) || 0) + tokens);
    win.total += tokens;
  }

  currentQps(id) {
    const bucket = this.qpsBuckets.get(id);
    return bucket ? Math.min(bucket.limit || 0, bucket.tokens) : 0;
  }

  cleanup() {
    const cutoff = now() - 10 * 60 * 1000;
    for (const [id, bucket] of this.qpsBuckets) {
      if (bucket.last < cutoff && bucket.tokens >= (bucket.limit || 0)) this.qpsBuckets.delete(id);
    }
    for (const [id, win] of this.tpmWindows) {
      this.tpmWindow(id);
      if (win.buckets.size === 0) this.tpmWindows.delete(id);
    }
  }
}
