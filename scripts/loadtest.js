#!/usr/bin/env node
/**
 * Built-in load generator for the gateway.
 * Usage:
 *   node scripts/loadtest.js --key sk-corp-... --model gpt-4o --concurrency 50 --duration 20
 *   node scripts/loadtest.js --key sk-corp-... --stream --concurrency 30 --duration 15
 */
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  if (i === args.length - 1) return true;
  return args[i + 1];
}
const url = String(flag('url', 'http://127.0.0.1:8080')).replace(/\/$/, '');
const key = flag('key', '');
const model = String(flag('model', 'gpt-4o'));
const concurrency = Math.max(1, Number(flag('concurrency', 20)) || 20);
const duration = Math.max(1, Number(flag('duration', 10)) || 10);
const maxTokens = Math.max(1, Number(flag('max-tokens', 64)) || 64);
const stream = args.includes('--stream');
const prompt = String(flag('prompt', '请用一句话介绍 LLM API Gateway 的核心价值。'));
if (!key) {
  console.error('缺少 --key。示例：node scripts/loadtest.js --key sk-corp-xxx --model gpt-4o --concurrency 50 --duration 20');
  process.exit(1);
}

const latencies = [];
const ttfts = [];
const statuses = new Map();
let success = 0;
let failed = 0;
let totalTokens = 0;
const stopAt = Date.now() + duration * 1000;

async function one() {
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        stream,
        stream_options: stream ? { include_usage: true } : undefined,
      }),
      signal: controller.signal,
    });
    statuses.set(res.status, (statuses.get(res.status) || 0) + 1);
    if (!res.ok) {
      await res.text();
      failed++;
      return;
    }
    if (!stream) {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }
      if (json?.usage?.total_tokens) totalTokens += json.usage.total_tokens;
      success++;
      latencies.push(performance.now() - started);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let first = null;
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (first === null) {
        first = performance.now() - started;
        ttfts.push(first);
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') { done = true; break; }
        if (!payload) continue;
        try {
          const json = JSON.parse(payload);
          if (json.usage?.total_tokens) totalTokens += json.usage.total_tokens;
          if (json.error) throw new Error(json.error.message);
        } catch (err) {
          if (err instanceof SyntaxError) continue;
          throw err;
        }
      }
    }
    success++;
    latencies.push(performance.now() - started);
  } catch {
    failed++;
    statuses.set('network', (statuses.get('network') || 0) + 1);
  } finally {
    clearTimeout(timeout);
  }
}

async function worker() {
  while (Date.now() < stopAt) await one();
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

const startedAt = Date.now();
console.log(`Load test → ${url}/v1/chat/completions | model=${model} | concurrency=${concurrency} | duration=${duration}s | mode=${stream ? 'stream' : 'non-stream'}`);
await Promise.all(Array.from({ length: concurrency }, () => worker()));
const elapsed = (Date.now() - startedAt) / 1000;
const total = success + failed;
const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;

console.log(JSON.stringify({
  elapsed_seconds: Number(elapsed.toFixed(2)),
  requests: total,
  success,
  failed,
  error_rate: total ? Number(((failed / total) * 100).toFixed(2)) : 0,
  rps: Number((total / elapsed).toFixed(1)),
  latency_ms: {
    avg: avg === null ? null : Number(avg.toFixed(1)),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
  },
  ttft_ms: stream ? {
    p50: percentile(ttfts, 50),
    p95: percentile(ttfts, 95),
    p99: percentile(ttfts, 99),
  } : null,
  tokens_total: totalTokens,
  status_counts: Object.fromEntries(statuses),
}, null, 2));
