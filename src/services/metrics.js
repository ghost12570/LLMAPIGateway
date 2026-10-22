const HIST_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000];

const escapeLabel = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.inflight = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;
    this.totalCancelled = 0;
    this.totalTokens = 0;
    this.totalCost = 0;
    this.streamRequests = 0;
    this.seconds = new Map();
    this.latencySamples = [];
    this.ttftSamples = [];
    this.byModel = new Map();
    this.byProvider = new Map();
    this.byChannel = new Map();
    this.histogram = new Array(HIST_BUCKETS.length).fill(0);
    this.ttftHistogram = new Array(HIST_BUCKETS.length).fill(0);
  }

  begin() {
    this.inflight++;
  }

  end() {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  bump(map, key) {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  }

  record({ status, latencyMs = 0, ttftMs = null, tokens = 0, cost = 0, model, provider, channelId, stream = false }) {
    this.totalRequests++;
    if (status === 'success') {
      // ok
    } else if (status === 'cancelled') {
      this.totalCancelled++;
    } else {
      this.totalErrors++;
    }
    this.totalTokens += tokens;
    this.totalCost += cost;
    if (stream) this.streamRequests++;

    const sec = Math.floor(Date.now() / 1000);
    let b = this.seconds.get(sec);
    if (!b) {
      b = { requests: 0, errors: 0, latencySum: 0, latencyCount: 0, ttftSum: 0, ttftCount: 0 };
      this.seconds.set(sec, b);
    }
    b.requests++;
    if (status !== 'success') b.errors++;
    b.latencySum += latencyMs;
    b.latencyCount++;
    if (ttftMs !== null && ttftMs !== undefined) {
      b.ttftSum += ttftMs;
      b.ttftCount++;
    }

    this.pushSample(this.latencySamples, latencyMs);
    if (ttftMs !== null && ttftMs !== undefined) this.pushSample(this.ttftSamples, ttftMs);

    const idx = HIST_BUCKETS.findIndex((edge) => latencyMs <= edge);
    if (idx >= 0) this.histogram[idx]++;
    if (ttftMs !== null && ttftMs !== undefined) {
      const tidx = HIST_BUCKETS.findIndex((edge) => ttftMs <= edge);
      if (tidx >= 0) this.ttftHistogram[tidx]++;
    }

    this.bump(this.byModel, model);
    this.bump(this.byProvider, provider);
    if (status !== 'success') this.bump(this.byChannel, channelId);

    const cutoff = sec - 300;
    if (this.seconds.size > 400) {
      for (const key of this.seconds.keys()) if (key < cutoff) this.seconds.delete(key);
    }
  }

  pushSample(arr, value) {
    arr.push(value);
    if (arr.length > 3000) arr.splice(0, arr.length - 3000);
  }

  percentile(arr, p) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  live() {
    const sec = Math.floor(Date.now() / 1000);
    let reqs = 0;
    let errs = 0;
    let latSum = 0;
    let latCount = 0;
    let ttftSum = 0;
    let ttftCount = 0;
    const series = [];
    for (let s = sec - 59; s <= sec; s++) {
      const b = this.seconds.get(s) || { requests: 0, errors: 0, latencySum: 0, latencyCount: 0, ttftSum: 0, ttftCount: 0 };
      if (s > sec - 5) {
        reqs += b.requests;
        errs += b.errors;
      }
      latSum += b.latencySum;
      latCount += b.latencyCount;
      ttftSum += b.ttftSum;
      ttftCount += b.ttftCount;
      series.push({ ts: s * 1000, requests: b.requests, errors: b.errors });
    }
    return {
      qps: Math.round((reqs / 5) * 10) / 10,
      inflight: this.inflight,
      avg_latency_ms: latCount ? Math.round(latSum / latCount) : null,
      avg_ttft_ms: ttftCount ? Math.round(ttftSum / ttftCount) : null,
      p95_latency_ms: this.percentile(this.latencySamples, 95),
      p99_latency_ms: this.percentile(this.latencySamples, 99),
      p95_ttft_ms: this.percentile(this.ttftSamples, 95),
      series,
    };
  }

  prometheus() {
    const lines = [];
    const m = (name, help, type) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} ${type}`);
    };
    m('llm_gateway_requests_total', 'Total gateway requests', 'counter');
    lines.push(`llm_gateway_requests_total ${this.totalRequests}`);
    m('llm_gateway_errors_total', 'Total failed gateway requests', 'counter');
    lines.push(`llm_gateway_errors_total ${this.totalErrors}`);
    m('llm_gateway_cancelled_total', 'Total cancelled gateway requests', 'counter');
    lines.push(`llm_gateway_cancelled_total ${this.totalCancelled}`);
    m('llm_gateway_inflight_requests', 'In-flight requests', 'gauge');
    lines.push(`llm_gateway_inflight_requests ${this.inflight}`);
    m('llm_gateway_tokens_total', 'Total tokens processed', 'counter');
    lines.push(`llm_gateway_tokens_total ${this.totalTokens}`);
    m('llm_gateway_cost_usd_total', 'Total upstream cost in USD', 'counter');
    lines.push(`llm_gateway_cost_usd_total ${this.totalCost}`);
    m('llm_gateway_stream_requests_total', 'Total streaming requests', 'counter');
    lines.push(`llm_gateway_stream_requests_total ${this.streamRequests}`);
    m('llm_gateway_uptime_seconds', 'Process uptime in seconds', 'gauge');
    lines.push(`llm_gateway_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);

    m('llm_gateway_latency_ms_bucket', 'Request latency histogram', 'histogram');
    let cumulative = 0;
    for (let i = 0; i < HIST_BUCKETS.length; i++) {
      cumulative += this.histogram[i];
      lines.push(`llm_gateway_latency_ms_bucket{le="${HIST_BUCKETS[i]}"} ${cumulative}`);
    }
    lines.push(`llm_gateway_latency_ms_bucket{le="+Inf"} ${this.totalRequests}`);
    lines.push(`llm_gateway_latency_ms_sum ${this.totalRequests ? this.latencySamples.reduce((a, b) => a + b, 0) : 0}`);
    lines.push(`llm_gateway_latency_ms_count ${this.latencySamples.length}`);

    m('llm_gateway_ttft_ms_bucket', 'Time to first token histogram', 'histogram');
    cumulative = 0;
    for (let i = 0; i < HIST_BUCKETS.length; i++) {
      cumulative += this.ttftHistogram[i];
      lines.push(`llm_gateway_ttft_ms_bucket{le="${HIST_BUCKETS[i]}"} ${cumulative}`);
    }
    lines.push(`llm_gateway_ttft_ms_bucket{le="+Inf"} ${this.ttftSamples.length}`);
    lines.push(`llm_gateway_ttft_ms_sum ${this.ttftSamples.reduce((a, b) => a + b, 0)}`);
    lines.push(`llm_gateway_ttft_ms_count ${this.ttftSamples.length}`);

    m('llm_gateway_requests_by_model_total', 'Requests by model', 'counter');
    for (const [model, count] of this.byModel) lines.push(`llm_gateway_requests_by_model_total{model="${escapeLabel(model)}"} ${count}`);
    m('llm_gateway_requests_by_provider_total', 'Requests by provider', 'counter');
    for (const [provider, count] of this.byProvider) lines.push(`llm_gateway_requests_by_provider_total{provider="${escapeLabel(provider)}"} ${count}`);
    m('llm_gateway_channel_errors_total', 'Errors by upstream channel', 'counter');
    for (const [channel, count] of this.byChannel) lines.push(`llm_gateway_channel_errors_total{channel="${escapeLabel(channel)}"} ${count}`);

    const mem = process.memoryUsage();
    m('llm_gateway_process_rss_bytes', 'Resident set size', 'gauge');
    lines.push(`llm_gateway_process_rss_bytes ${mem.rss}`);
    m('llm_gateway_process_heap_used_bytes', 'Heap used', 'gauge');
    lines.push(`llm_gateway_process_heap_used_bytes ${mem.heapUsed}`);
    return lines.join('\n') + '\n';
  }
}
