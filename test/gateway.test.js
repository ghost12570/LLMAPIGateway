import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startEnv, request, adminApi, login, createModel, createChannel, createUser, createKey, apiCall, parseSse,
} from './helpers.js';
import { decryptSecret } from '../src/util/crypto.js';
import { anthropicAdapter } from '../src/providers/anthropic.js';

let env;
let devUser;
let devKey;
let devCookie;

before(async () => {
  env = await startEnv();

  for (const alias of ['gpt-4o', 'gpt-4o-mini', 'text-embedding-3-small', 'text-embedding-3-large', 'claude-3-5-sonnet', 'claude-3-5-haiku']) {
    const res = await adminApi(env, `/api/admin/models/${alias}`, { method: 'PUT', body: { visible: true } });
    assert.equal(res.status, 200, res.text);
  }

  await createChannel(env, {
    name: 'test-openai', provider: 'openai', baseUrl: `${env.mock.baseUrl}/v1`, priority: 1, weight: 10,
    models: [
      { alias: 'gpt-4o', upstream_model: 'gpt-4o', enabled: true },
      { alias: 'gpt-4o-mini', upstream_model: 'gpt-4o-mini', enabled: true },
      { alias: 'text-embedding-3-small', upstream_model: 'text-embedding-3-small', enabled: true },
      { alias: 'text-embedding-3-large', upstream_model: 'text-embedding-3-large', enabled: true },
    ],
  });
  await createChannel(env, {
    name: 'test-anthropic', provider: 'anthropic', baseUrl: `${env.mock.baseUrl}/anthropic`, priority: 1, weight: 10,
    models: [
      { alias: 'claude-3-5-sonnet', upstream_model: 'claude-3-5-sonnet-20241022', enabled: true },
      { alias: 'claude-3-5-haiku', upstream_model: 'claude-3-5-haiku-20241022', enabled: true },
    ],
    keys: ['sk-ant-test'],
  });

  for (const alias of ['test-usage-missing', 'test-abort-stream', 'test-failover', 'test-circuit', 'test-client-error']) {
    await createModel(env, alias);
  }
  await createModel(env, 'test-tiny', { context_window: 10 });
  await createModel(env, 'test-chain-primary', { fallback_chain: ['test-failover'] });
  await createModel(env, 'test-azure');

  await createChannel(env, {
    name: 'test-no-usage', baseUrl: `${env.mock.baseUrl}/v1`, priority: 1,
    models: [{ alias: 'test-usage-missing', upstream_model: 'gpt-4o', enabled: true }],
    headers: { 'x-mock-no-usage': '1' },
  });
  await createChannel(env, {
    name: 'test-abort', baseUrl: `${env.mock.baseUrl}/v1`, priority: 1,
    models: [{ alias: 'test-abort-stream', upstream_model: 'gpt-4o', enabled: true }],
    headers: { 'x-mock-abort-after': '3' },
  });
  await createChannel(env, {
    name: 'test-failover-bad', baseUrl: `${env.mock.baseUrl}/v1`, priority: 1,
    models: [{ alias: 'test-failover', upstream_model: 'gpt-4o', enabled: true }],
    headers: { 'x-mock-status': '500' },
  });
  await createChannel(env, {
    name: 'test-failover-good', baseUrl: `${env.mock.baseUrl}/v1`, priority: 2,
    models: [
      { alias: 'test-failover', upstream_model: 'gpt-4o', enabled: true },
      { alias: 'test-tiny', upstream_model: 'gpt-4o', enabled: true },
    ],
  });
  await createChannel(env, {
    name: 'test-circuit-down', baseUrl: `${env.mock.baseUrl}/v1`, priority: 1,
    models: [{ alias: 'test-circuit', upstream_model: 'gpt-4o', enabled: true }],
    headers: { 'x-mock-status': '500' },
  });
  await createChannel(env, {
    name: 'test-client-error', baseUrl: `${env.mock.baseUrl}/v1`, priority: 1,
    models: [{ alias: 'test-client-error', upstream_model: 'gpt-4o', enabled: true }],
    headers: { 'x-mock-status': '400' },
  });
  await createChannel(env, {
    name: 'test-chain-start', baseUrl: `${env.mock.baseUrl}/v1`, priority: 1,
    models: [{ alias: 'test-chain-primary', upstream_model: 'gpt-4o', enabled: true }],
    headers: { 'x-mock-status': '500' },
  });
  await createChannel(env, {
    name: 'test-azure', provider: 'azure', baseUrl: `${env.mock.baseUrl}/azure`, priority: 1,
    models: [{ alias: 'test-azure', upstream_model: 'my-gpt4o-deployment', enabled: true }],
    keys: ['sk-azure-test'],
  });
  await createChannel(env, {
    name: 'test-deepseek', provider: 'deepseek', baseUrl: `${env.mock.baseUrl}/v1`, priority: 1,
    models: [{ alias: 'deepseek-reasoner', upstream_model: 'deepseek-reasoner', enabled: true }],
    keys: ['sk-deepseek-test'],
  });

  env.app.health.stop();

  devUser = await createUser(env, { email: 'tester@corp.local', name: '测试开发者', quota: 100 });
  const created = await createKey(env, devUser.id, { name: 'E2E-Key', monthly_limit_usd: 100, qps_limit: 100 });
  devKey = created.plaintext;
  devCookie = await login(env, 'tester@corp.local');
});

after(async () => {
  if (env) await env.close();
});

test('health endpoints and API authentication', async () => {
  const health = await request(env.base, '/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');

  const noauth = await request(env.base, '/v1/chat/completions', {
    method: 'POST', body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
  });
  assert.equal(noauth.status, 401);
  assert.equal(noauth.json.error.code, 'invalid_api_key');
  assert.equal(noauth.json.error.type, 'authentication_error');

  const bad = await apiCall(env, `sk-corp-${'A'.repeat(32)}`, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'invalid_api_key');

  const me = await request(env.base, '/auth/me', { cookie: env.adminCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.role, 'SUPER_ADMIN');
  assert.equal(me.json.permissions.manage_platform, true);
});

test('admin channels, encrypted master keys and overview', async () => {
  const channels = await adminApi(env, '/api/admin/channels');
  assert.equal(channels.status, 200);
  const openai = channels.json.items.find((c) => c.name === 'test-openai');
  assert.ok(openai);
  assert.equal(openai.key_count, 1);
  assert.equal(openai.models.length, 4);
  assert.equal(openai.circuit.state, 'closed');

  const row = env.app.db.get('SELECT encrypted_key FROM channel_keys WHERE channel_id = ?', openai.id);
  assert.ok(row);
  assert.ok(!row.encrypted_key.includes('sk-test-upstream'));
  assert.equal(decryptSecret(env.app.config.masterSecret, row.encrypted_key), 'sk-test-upstream');

  const overview = await adminApi(env, '/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.json.counts.channels >= 8);
  assert.ok(Array.isArray(overview.json.series));
  assert.ok(overview.json.series.length >= 288);
});

test('OpenAI compatible models endpoint is filtered and annotated', async () => {
  const models = await request(env.base, '/v1/models', { headers: { Authorization: `Bearer ${devKey}` } });
  assert.equal(models.status, 200);
  const ids = models.json.data.map((m) => m.id);
  assert.ok(ids.includes('gpt-4o'));
  assert.ok(ids.includes('gpt-4o-mini'));
  assert.ok(ids.includes('text-embedding-3-small'));
  assert.ok(!ids.includes('deepseek-chat'), 'hidden or unavailable models must be filtered');
  const gpt = models.json.data.find((m) => m.id === 'gpt-4o');
  assert.equal(gpt.available, true);
  assert.equal(gpt.pricing.unit, '1K tokens');
  assert.ok(Array.isArray(gpt.capabilities));
});

test('non-streaming chat works, is billed and logged without prompt content', async () => {
  const res = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello gateway, this is a private prompt' }],
    max_tokens: 100,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.model, 'gpt-4o');
  assert.equal(res.json.object, 'chat.completion');
  assert.match(res.json.choices[0].message.content, /gpt-4o/);
  assert.ok(res.json.usage.prompt_tokens > 0);
  assert.ok(res.json.usage.completion_tokens > 0);
  assert.equal(res.json.usage.total_tokens, res.json.usage.prompt_tokens + res.json.usage.completion_tokens);
  assert.equal(res.headers.get('x-gateway-provider'), 'openai');
  assert.equal(res.headers.get('x-gateway-model'), 'gpt-4o');

  const requestId = res.headers.get('x-request-id');
  assert.ok(requestId?.startsWith('req_'));
  const logs = await adminApi(env, `/api/admin/logs?q=${requestId}`);
  assert.equal(logs.status, 200);
  const log = logs.json.items.find((l) => l.id === requestId);
  assert.ok(log);
  assert.equal(log.status, 'success');
  assert.equal(log.http_status, 200);
  assert.equal(log.model, 'gpt-4o');
  assert.ok(log.channel_id);
  assert.ok(log.prompt_tokens > 0);
  assert.ok(log.cost_usd > 0);
  assert.equal(Object.prototype.hasOwnProperty.call(log, 'prompt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(log, 'messages'), false);

  const audit = await adminApi(env, '/api/admin/audit');
  assert.equal(audit.status, 200);
  assert.ok(audit.json.items.some((a) => a.action === 'auth.login.success'));
});

test('smart routing alias auto resolves to an available model', async () => {
  const res = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'auto',
    messages: [{ role: 'user', content: '用一句话总结' }],
    max_tokens: 50,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.model, 'auto');
  assert.notEqual(res.headers.get('x-gateway-model'), 'auto');
  assert.ok(res.json.choices[0].message.content);

  const streamed = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'auto',
    messages: [{ role: 'user', content: '再总结一次' }],
    stream: true,
    max_tokens: 50,
  });
  assert.equal(streamed.status, 200, streamed.text);
  const chunks = parseSse(streamed.text).filter((e) => typeof e === 'object');
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.model === 'auto'), 'stream chunks must expose the requested alias');
});

test('SSE streaming synthesizes usage when upstream omits it', async () => {
  const res = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'test-usage-missing',
    messages: [{ role: 'user', content: 'stream without upstream usage' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 200,
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.match(res.headers.get('cache-control'), /no-cache/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const events = parseSse(res.text);
  assert.ok(events.filter((e) => typeof e === 'object').length > 3);
  assert.equal(events[events.length - 1], '[DONE]');
  const usageEvent = events.filter((e) => typeof e === 'object' && !e.choices?.length && e.usage).at(-1);
  assert.ok(usageEvent, 'a usage chunk must be synthesized');
  assert.ok(usageEvent.usage.prompt_tokens > 0);
  assert.ok(usageEvent.usage.completion_tokens > 0);
  const requestId = res.headers.get('x-request-id');
  const logs = await adminApi(env, `/api/admin/logs?q=${requestId}`);
  const log = logs.json.items.find((l) => l.id === requestId);
  assert.equal(log.status, 'success');
  assert.equal(log.estimated, 1);
  assert.ok(log.completion_tokens > 0);
});

test('Anthropic protocol conversion works for non-stream, stream and legacy completions', async () => {
  const chat = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'claude-3-5-sonnet',
    messages: [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'hello claude' },
    ],
    max_tokens: 80,
  });
  assert.equal(chat.status, 200, chat.text);
  assert.equal(chat.json.model, 'claude-3-5-sonnet');
  assert.match(chat.json.choices[0].message.content, /claude/);
  assert.ok(chat.json.usage.prompt_tokens > 0);
  assert.ok(chat.json.usage.completion_tokens > 0);
  assert.equal(chat.headers.get('x-gateway-provider'), 'anthropic');

  const stream = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'claude-3-5-sonnet',
    messages: [{ role: 'user', content: 'stream from claude' }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 80,
  });
  assert.equal(stream.status, 200, stream.text);
  const events = parseSse(stream.text);
  const chunks = events.filter((e) => typeof e === 'object');
  assert.ok(chunks.length > 3);
  assert.equal(events.at(-1), '[DONE]');
  const ids = new Set(chunks.map((c) => c.id));
  assert.equal(ids.size, 1, 'all streaming chunks must share a stable id');
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.content));
  assert.ok(chunks.some((c) => c.usage && c.usage.completion_tokens > 0));
  const finish = chunks.find((c) => c.choices?.[0]?.finish_reason === 'stop');
  assert.ok(finish);

  const legacy = await apiCall(env, devKey, '/v1/completions', {
    model: 'claude-3-5-sonnet', prompt: 'legacy prompt', max_tokens: 50,
  });
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(legacy.json.object, 'text_completion');
  assert.match(legacy.json.choices[0].text, /claude/);

  const legacyStream = await apiCall(env, devKey, '/v1/completions', {
    model: 'claude-3-5-sonnet', prompt: 'legacy stream', stream: true, max_tokens: 50,
  });
  assert.equal(legacyStream.status, 200, legacyStream.text);
  const legacyEvents = parseSse(legacyStream.text);
  assert.equal(legacyEvents.at(-1), '[DONE]');
  assert.ok(legacyEvents.filter((e) => typeof e === 'object').every((e) => e.object === 'text_completion'));
});

test('Anthropic request converter maps system, tools and tool results', () => {
  const built = anthropicAdapter.buildRequest({
    channel: { base_url: 'https://api.anthropic.com', headers: {} },
    upstreamModel: 'claude-3-5-sonnet-20241022',
    endpoint: 'chat',
    stream: false,
    apiKey: 'x',
    targetModel: { max_output_tokens: 8192 },
    body: {
      messages: [
        { role: 'system', content: 'System rules' },
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Shanghai"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
      tool_choice: 'auto',
      max_tokens: 500,
      frequency_penalty: 1,
    },
  });
  const payload = JSON.parse(built.body);
  assert.equal(payload.system, 'System rules');
  assert.equal(payload.max_tokens, 500);
  assert.equal(payload.tools[0].name, 'get_weather');
  assert.equal(payload.tool_choice.type, 'auto');
  assert.equal(payload.messages[0].role, 'user');
  const toolUse = payload.messages.find((m) => m.role === 'assistant').content.find((b) => b.type === 'tool_use');
  assert.equal(toolUse.name, 'get_weather');
  assert.equal(toolUse.input.city, 'Shanghai');
  const toolResult = payload.messages.at(-1).content.find((b) => b.type === 'tool_result');
  assert.equal(toolResult.tool_use_id, 'call_1');
  assert.equal(payload.frequency_penalty, undefined);
});

test('Azure deployment mapping and DeepSeek reasoning_content pass-through work', async () => {
  const azure = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'test-azure', messages: [{ role: 'user', content: 'azure hello' }], max_tokens: 40,
  });
  assert.equal(azure.status, 200, azure.text);
  assert.equal(azure.json.model, 'test-azure');
  assert.equal(azure.headers.get('x-gateway-provider'), 'azure');
  assert.match(azure.json.choices[0].message.content, /azure|模拟|my-gpt4o/i);

  const ds = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'deepseek-reasoner',
    messages: [{ role: 'user', content: 'reason about this' }],
    stream: true,
    max_tokens: 100,
  });
  assert.equal(ds.status, 200, ds.text);
  const chunks = parseSse(ds.text).filter((e) => typeof e === 'object');
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.reasoning_content), 'reasoning_content must be preserved');
  assert.ok(chunks.some((c) => c.choices?.[0]?.delta?.content));
  assert.ok(chunks.every((c) => c.model === 'deepseek-reasoner'));
});

test('embeddings and OpenAI legacy completions work', async () => {
  const emb = await apiCall(env, devKey, '/v1/embeddings', {
    model: 'text-embedding-3-small', input: 'hello embedding',
  });
  assert.equal(emb.status, 200, emb.text);
  assert.ok(Array.isArray(emb.json.data));
  assert.ok(emb.json.data[0].embedding.length > 0);
  assert.ok(emb.json.usage.prompt_tokens > 0);
  assert.equal(emb.json.usage.completion_tokens, 0);

  const legacy = await apiCall(env, devKey, '/v1/completions', {
    model: 'gpt-4o', prompt: 'Hello', max_tokens: 30,
  });
  assert.equal(legacy.status, 200, legacy.text);
  assert.equal(legacy.json.object, 'text_completion');
  assert.match(legacy.json.choices[0].text, /Hello|模拟/);
});

test('fallback retries another channel before the first byte', async () => {
  const res = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'test-failover',
    messages: [{ role: 'user', content: 'fallback please' }],
    max_tokens: 40,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers.get('x-gateway-attempts'), '2');
  const requestId = res.headers.get('x-request-id');
  const logs = await adminApi(env, `/api/admin/logs?q=${requestId}`);
  const log = logs.json.items.find((l) => l.id === requestId);
  assert.equal(log.status, 'success');
  assert.equal(log.attempts, 2);
  const channels = await adminApi(env, '/api/admin/channels');
  const good = channels.json.items.find((c) => c.name === 'test-failover-good');
  assert.equal(log.channel_id, good.id);
});

test('cross-model fallback chain recovers after primary failure', async () => {
  const res = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'test-chain-primary',
    messages: [{ role: 'user', content: 'use the fallback chain' }],
    max_tokens: 40,
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers.get('x-gateway-attempts'), '3');
  const requestId = res.headers.get('x-request-id');
  const logs = await adminApi(env, `/api/admin/logs?q=${requestId}`);
  const log = logs.json.items.find((l) => l.id === requestId);
  assert.equal(log.status, 'success');
  assert.equal(log.model, 'test-chain-primary');
  assert.equal(log.attempts, 3);
  assert.ok(log.upstream_model);
});

test('mid-stream upstream reset emits a standardized SSE error and partial billing', async () => {
  const res = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'test-abort-stream',
    messages: [{ role: 'user', content: 'abort in the middle' }],
    stream: true,
    max_tokens: 200,
  });
  assert.equal(res.status, 200, res.text);
  const events = parseSse(res.text);
  assert.ok(!events.includes('[DONE]'));
  const err = events.find((e) => typeof e === 'object' && e.error);
  assert.ok(err, 'expected standardized error event');
  assert.match(err.error.message, /reset|connection/i);
  assert.equal(err.error.code, 'upstream_connection_failed');
  const requestId = res.headers.get('x-request-id');
  const logs = await adminApi(env, `/api/admin/logs?q=${requestId}`);
  const log = logs.json.items.find((l) => l.id === requestId);
  assert.equal(log.status, 'error');
  assert.equal(log.http_status, 502);
  assert.equal(log.error_code, 'upstream_connection_failed');
  assert.ok(log.completion_tokens > 0, 'partial generation should be metered');
  assert.ok(log.cost_usd > 0);
});

test('circuit breaker opens, blocks traffic and can be reset', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await apiCall(env, devKey, '/v1/chat/completions', {
      model: 'test-circuit',
      messages: [{ role: 'user', content: `failure ${i}` }],
      max_tokens: 20,
    });
    assert.equal(res.status, 502, res.text);
    assert.equal(res.json.error.code, 'upstream_connection_failed');
  }
  let channels = await adminApi(env, '/api/admin/channels');
  let down = channels.json.items.find((c) => c.name === 'test-circuit-down');
  assert.equal(down.circuit.state, 'open');

  const blocked = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'test-circuit',
    messages: [{ role: 'user', content: 'blocked?' }],
  });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.json.error.code, 'no_available_channel');

  const reset = await adminApi(env, `/api/admin/channels/${down.id}/reset-circuit`, { method: 'POST' });
  assert.equal(reset.status, 200);
  channels = await adminApi(env, '/api/admin/channels');
  down = channels.json.items.find((c) => c.name === 'test-circuit-down');
  assert.equal(down.circuit.state, 'closed');
});

test('upstream 4xx is not retried and does not trip the circuit', async () => {
  const res = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'test-client-error',
    messages: [{ role: 'user', content: 'bad request' }],
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.type, 'invalid_request_error');
  const requestId = res.headers.get('x-request-id');
  const logs = await adminApi(env, `/api/admin/logs?q=${requestId}`);
  const log = logs.json.items.find((l) => l.id === requestId);
  assert.equal(log.attempts, 1);
  const channels = await adminApi(env, '/api/admin/channels');
  const channel = channels.json.items.find((c) => c.name === 'test-client-error');
  assert.equal(channel.circuit.state, 'closed');
});

test('quota hard limits block requests with 429', async () => {
  const poor = await createUser(env, { email: 'poor@corp.local', name: '低额度用户', quota: 0.001 });
  const k = await createKey(env, poor.id, { name: 'Poor-Key' });
  const res = await apiCall(env, k.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'quota test' }], max_tokens: 100,
  });
  assert.equal(res.status, 429, res.text);
  assert.equal(res.json.error.code, 'quota_exceeded');

  const updated = await adminApi(env, `/api/admin/users/${poor.id}`, { method: 'PUT', body: { monthly_quota_usd: 100 } });
  assert.equal(updated.status, 200, updated.text);
  const ok = await apiCall(env, k.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'after raise' }], max_tokens: 50,
  });
  assert.equal(ok.status, 200, ok.text);

  const limitedUser = await createUser(env, { email: 'keylimit@corp.local', name: 'Key Limit' });
  const limitedKey = await createKey(env, limitedUser.id, { name: 'Limited-Key', monthly_limit_usd: 0.001 });
  const blocked = await apiCall(env, limitedKey.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'key limit' }],
  });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.error.code, 'quota_exceeded');

  const totalUser = await createUser(env, { email: 'totallimit@corp.local', name: 'Total Limit' });
  const totalKey = await createKey(env, totalUser.id, { name: 'Total-Limited-Key', total_limit_usd: 0.001 });
  const totalBlocked = await apiCall(env, totalKey.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'total limit' }],
  });
  assert.equal(totalBlocked.status, 429);
  assert.equal(totalBlocked.json.error.code, 'quota_exceeded');
});

test('per-key QPS limiting returns 429 with Retry-After', async () => {
  const user = await createUser(env, { email: 'ratelimit@corp.local', name: 'Rate Limit' });
  const k = await createKey(env, user.id, { name: 'Slow-Key', qps_limit: 1 });
  const first = await apiCall(env, k.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'one' }], max_tokens: 20,
  });
  assert.equal(first.status, 200);
  const second = await apiCall(env, k.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'two' }], max_tokens: 20,
  });
  assert.equal(second.status, 429);
  assert.equal(second.json.error.code, 'rate_limit_exceeded');
  assert.ok(Number(second.headers.get('retry-after')) >= 1);
});

test('IP whitelist, model whitelist, model validation and context limits', async () => {
  const ipUser = await createUser(env, { email: 'ip@corp.local', name: 'IP User' });
  const ipKey = await createKey(env, ipUser.id, { name: 'IP-Key', ip_whitelist: ['10.0.0.0/8'] });
  const blocked = await apiCall(env, ipKey.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'ip' }],
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, 'ip_not_allowed');

  const allowUser = await createUser(env, { email: 'models@corp.local', name: 'Model User' });
  const allowKey = await createKey(env, allowUser.id, { name: 'Model-Key', allowed_models: ['gpt-4o'] });
  const notAllowed = await apiCall(env, allowKey.plaintext, '/v1/chat/completions', {
    model: 'deepseek-chat', messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(notAllowed.status, 403);
  assert.equal(notAllowed.json.error.code, 'model_not_allowed');
  const allowed = await apiCall(env, allowKey.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }], max_tokens: 20,
  });
  assert.equal(allowed.status, 200);

  const missing = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'definitely-not-a-model', messages: [{ role: 'user', content: 'x' }],
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'model_not_found');

  const tooLong = await apiCall(env, devKey, '/v1/chat/completions', {
    model: 'test-tiny', messages: [{ role: 'user', content: 'x'.repeat(200) }],
  });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.json.error.code, 'context_length_exceeded');

  const invalid = await apiCall(env, devKey, '/v1/chat/completions', { model: 'gpt-4o', messages: [] });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, 'invalid_messages');
});

test('batch user import creates accounts and skips duplicates', async () => {
  const payload = {
    users: [
      { name: '批量用户一', email: 'bulk1@corp.local', role: 'APP_USER', org_name: '总部', monthly_quota_usd: 5, password: 'BulkPass1!' },
      { name: '批量用户二', email: 'bulk2@corp.local', role: 'AUDITOR', org_name: '总部', monthly_quota_usd: 0, password: '' },
      { name: '坏邮箱', email: 'not-an-email', role: 'APP_USER' },
    ],
  };
  const first = await adminApi(env, '/api/admin/users/import', { method: 'POST', body: payload });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.created, 2);
  assert.equal(first.json.errors.length, 1);
  assert.equal(first.json.credentials.length, 2);
  const cookie = await login(env, 'bulk1@corp.local', 'BulkPass1!');
  assert.ok(cookie);

  const again = await adminApi(env, '/api/admin/users/import', {
    method: 'POST',
    body: { users: payload.users.slice(0, 2) },
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, 0);
  assert.equal(again.json.skipped, 2);
});

test('RBAC boundaries for org admin, auditor and app user', async () => {
  const orgAdmin = await createUser(env, { email: 'orgadmin-test@corp.local', name: 'Org Admin', role: 'ORG_ADMIN' });
  const auditor = await createUser(env, { email: 'auditor-test@corp.local', name: 'Auditor', role: 'AUDITOR' });
  const appUser = await createUser(env, { email: 'appuser-test@corp.local', name: 'App User' });

  const orgCookie = await login(env, orgAdmin.email);
  assert.equal((await request(env.base, '/api/admin/overview', { cookie: orgCookie })).status, 200);
  assert.equal((await request(env.base, '/api/admin/settings', { cookie: orgCookie })).status, 403);
  const orgCreateChannel = await request(env.base, '/api/admin/channels', {
    method: 'POST', cookie: orgCookie,
    body: { name: 'x', provider: 'openai', base_url: 'https://example.com/v1' },
  });
  assert.equal(orgCreateChannel.status, 403);
  assert.equal((await request(env.base, '/api/admin/users', { cookie: orgCookie })).status, 200);

  const auditorCookie = await login(env, auditor.email);
  assert.equal((await request(env.base, '/api/admin/logs', { cookie: auditorCookie })).status, 200);
  assert.equal((await request(env.base, '/api/admin/audit', { cookie: auditorCookie })).status, 200);
  assert.equal((await request(env.base, '/api/admin/users', { method: 'POST', cookie: auditorCookie, body: { email: 'x@y.z', name: 'x' } })).status, 403);

  const appCookie = await login(env, appUser.email);
  assert.equal((await request(env.base, '/api/admin/overview', { cookie: appCookie })).status, 403);
  const portalKey = await request(env.base, '/api/portal/keys', {
    method: 'POST', cookie: appCookie, body: { name: 'Portal-Key', qps_limit: 5 },
  });
  assert.equal(portalKey.status, 201, portalKey.text);
  assert.ok(portalKey.json.plaintext.startsWith('sk-corp-'));
  const portalKeys = await request(env.base, '/api/portal/keys', { cookie: appCookie });
  assert.equal(portalKeys.status, 200);
  assert.ok(portalKeys.json.items.length >= 1);
  assert.ok(!('lookup_hash' in portalKeys.json.items[0]));
  assert.ok(!('key_hash' in portalKeys.json.items[0]));

  const use = await apiCall(env, portalKey.json.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'portal key' }], max_tokens: 20,
  });
  assert.equal(use.status, 200);

  const playground = await request(env.base, '/api/portal/playground', {
    method: 'POST', cookie: appCookie,
    body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'playground' }], stream: false, max_tokens: 30 },
  });
  assert.equal(playground.status, 200, playground.text);
  assert.ok(playground.json.choices[0].message.content);
  const portalLogs = await request(env.base, '/api/portal/logs?page_size=5', { cookie: appCookie });
  assert.equal(portalLogs.status, 200);
  assert.ok(portalLogs.json.items.some((l) => l.source === 'playground'));

  // A portal user can view the model catalog, but cannot manage platform resources.
  assert.equal((await request(env.base, '/api/portal/models', { cookie: appCookie })).status, 200);
});

test('SSO client secrets are encrypted at rest', async () => {
  const current = await adminApi(env, '/api/admin/settings');
  assert.equal(current.status, 200);
  const provider = {
    id: 'test-oidc',
    name: 'Test OIDC',
    type: 'oidc',
    enabled: true,
    client_id: 'client-id',
    client_secret: 'super-secret-value',
    issuer: 'https://idp.example.invalid',
    scope: 'openid profile email',
    redirect_path: '/auth/sso/test-oidc/callback',
  };
  const put = await adminApi(env, '/api/admin/settings', { method: 'PUT', body: { 'sso.providers': [provider] } });
  assert.equal(put.status, 200, put.text);
  const stored = env.app.db.get("SELECT value FROM settings WHERE key = 'sso.providers'").value;
  assert.ok(stored.includes('enc:v1:'));
  assert.ok(!stored.includes('super-secret-value'));
  const read = await adminApi(env, '/api/admin/settings');
  assert.equal(read.json.sso_providers[0].client_secret, 'super-secret-value');
  assert.equal(env.app.auth.getProvider('test-oidc').client_secret, 'super-secret-value');
});

test('revoked API keys are rejected immediately', async () => {
  const user = await createUser(env, { email: 'revoke@corp.local', name: 'Revoke User' });
  const k = await createKey(env, user.id, { name: 'Revoke-Key' });
  const before = await apiCall(env, k.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'alive' }], max_tokens: 20,
  });
  assert.equal(before.status, 200);
  const revoke = await adminApi(env, `/api/admin/keys/${k.key.id}`, { method: 'DELETE' });
  assert.equal(revoke.status, 200);
  const after = await apiCall(env, k.plaintext, '/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'dead' }], max_tokens: 20,
  });
  assert.equal(after.status, 401);
  assert.equal(after.json.error.code, 'invalid_api_key');
});

test('metrics, billing summary and CSV export', async () => {
  const metrics = await request(env.base, '/metrics');
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers.get('content-type'), /text\/plain/);
  assert.match(metrics.text, /llm_gateway_requests_total/);
  assert.match(metrics.text, /llm_gateway_tokens_total/);

  const from = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const billing = await adminApi(env, `/api/admin/billing?from=${from}&to=${to}&group_by=model`);
  assert.equal(billing.status, 200, billing.text);
  assert.ok(billing.json.summary.requests > 0);
  assert.ok(billing.json.items.length > 0);

  const daily = await adminApi(env, '/api/admin/usage/daily?days=7');
  assert.equal(daily.status, 200);
  assert.equal(daily.json.items.length, 7);

  const overviewNow = await adminApi(env, '/api/admin/overview');
  assert.equal(overviewNow.status, 200);
  assert.ok(overviewNow.json.series.some((p) => p.requests > 0), '24h series must contain actual traffic');

  const csvRes = await fetch(`${env.base}/api/admin/billing/export.csv?from=${from}&to=${to}&group_by=model`, { headers: { Cookie: env.adminCookie } });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get('content-type'), /text\/csv/);
  const csvBuffer = Buffer.from(await csvRes.arrayBuffer());
  assert.equal(csvBuffer[0], 0xEF);
  assert.equal(csvBuffer[1], 0xBB);
  assert.equal(csvBuffer[2], 0xBF);
  assert.match(csvBuffer.toString('utf8'), /成本\(USD\)/);
});
