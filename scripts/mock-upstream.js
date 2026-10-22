import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function estimate(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 3));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); }
    });
  });
}

function textFromMessages(messages = []) {
  return messages.map((m) => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) return m.content.map((p) => p?.text || '').join('');
    return '';
  }).join(' ');
}

function makeReply(model, prompt) {
  const preview = String(prompt || '').replace(/\s+/g, ' ').slice(0, 60);
  return `你好！我是 ${model} 的模拟响应。\n\n已收到你的请求${preview ? `：“${preview}”` : ''}。\n这是一条用于验证 LLM Gateway 协议转换、SSE 流式转发、用量计费与故障切换的测试消息。当前时间戳：${Date.now()}。`;
}

function writeSse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handleOpenAIChat(req, res, body) {
  const status = Number(req.headers['x-mock-status'] || 0);
  if (status >= 400) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Mock upstream forced error ${status}`, type: 'server_error', code: 'mock_error' } }));
    return;
  }
  const firstDelay = Number(req.headers['x-mock-first-delay'] || process.env.MOCK_FIRST_DELAY_MS || 8);
  await sleep(firstDelay);
  const model = body.model || 'gpt-4o';
  const prompt = textFromMessages(body.messages);
  const reply = makeReply(model, prompt);
  const promptTokens = estimate(prompt) + 8;
  const completionTokens = estimate(reply);

  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const id = `chatcmpl-mock-${Date.now()}`;
    const created = now();
    const base = { id, object: 'chat.completion.chunk', created, model };
    writeSse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (/reasoner|o1|o3/i.test(model) || body.mock_reasoning) {
      for (const part of ['让我先分析一下这个问题。', '用户希望获得一个可验证的流式响应。']) {
        writeSse(res, { ...base, choices: [{ index: 0, delta: { reasoning_content: part }, finish_reason: null }] });
        await sleep(6);
      }
    }
    const chunks = reply.match(/[\s\S]{1,6}/g) || [reply];
    const abortAfter = Number(req.headers['x-mock-abort-after'] || 0);
    let sent = 0;
    for (const chunk of chunks) {
      writeSse(res, { ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
      sent++;
      if (abortAfter > 0 && sent >= abortAfter) {
        res.destroy();
        return;
      }
      await sleep(4);
    }
    writeSse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    const omitUsage = req.headers['x-mock-no-usage'] === '1';
    if (body.stream_options?.include_usage && !omitUsage) {
      writeSse(res, {
        ...base,
        choices: [],
        usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
      });
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: `chatcmpl-mock-${Date.now()}`,
    object: 'chat.completion',
    created: now(),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop', logprobs: null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }));
}

async function handleOpenAICompletions(req, res, body) {
  await sleep(8);
  const model = body.model || 'gpt-4o';
  const prompt = Array.isArray(body.prompt) ? body.prompt.join('\n') : String(body.prompt || '');
  const text = `模拟补全结果：${prompt.slice(0, 50)} 的后续内容。`;
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const base = { id: `cmpl-mock-${Date.now()}`, object: 'text_completion', created: now(), model };
    writeSse(res, { ...base, choices: [{ text: '', index: 0, logprobs: null, finish_reason: null }] });
    for (const part of text.match(/[\s\S]{1,6}/g) || []) {
      writeSse(res, { ...base, choices: [{ text: part, index: 0, logprobs: null, finish_reason: null }] });
      await sleep(4);
    }
    writeSse(res, { ...base, choices: [{ text: '', index: 0, logprobs: null, finish_reason: 'stop' }] });
    if (body.stream_options?.include_usage) {
      writeSse(res, { ...base, choices: [], usage: { prompt_tokens: estimate(prompt), completion_tokens: estimate(text), total_tokens: estimate(prompt) + estimate(text) } });
    }
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: `cmpl-mock-${Date.now()}`,
    object: 'text_completion',
    created: now(),
    model,
    choices: [{ text, index: 0, logprobs: null, finish_reason: 'stop' }],
    usage: { prompt_tokens: estimate(prompt), completion_tokens: estimate(text), total_tokens: estimate(prompt) + estimate(text) },
  }));
}

function handleEmbeddings(req, res, body) {
  const input = Array.isArray(body.input) ? body.input : [body.input];
  const data = input.map((text, index) => ({
    object: 'embedding',
    index,
    embedding: Array.from({ length: 16 }, (_, i) => Math.sin((String(text).length + i) * 0.37) / 2),
  }));
  const tokens = input.reduce((sum, t) => sum + estimate(typeof t === 'string' ? t : JSON.stringify(t)), 0);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    object: 'list',
    data,
    model: body.model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  }));
}

async function handleAnthropicMessages(req, res, body) {
  const status = Number(req.headers['x-mock-status'] || 0);
  if (status >= 400) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `Mock Anthropic forced error ${status}` } }));
    return;
  }
  await sleep(Number(req.headers['x-mock-first-delay'] || process.env.MOCK_FIRST_DELAY_MS || 8));
  const model = body.model || 'claude-3-5-sonnet';
  const prompt = textFromMessages(body.messages);
  const reply = makeReply(model, prompt);
  const inputTokens = estimate(prompt) + 10;
  const outputTokens = estimate(reply);
  const messageId = `msg_mock_${Date.now()}`;

  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('message_start', {
      message: {
        id: messageId, type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const part of reply.match(/[\s\S]{1,7}/g) || [reply]) {
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
      await sleep(4);
    }
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outputTokens } });
    send('message_stop', {});
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    id: messageId,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: reply }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }));
}

export function startMockUpstream({ port = 9900, host = '127.0.0.1' } = {}) {
  const stats = { requests: 0, errors: 0, byProvider: { openai: 0, anthropic: 0 } };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    stats.requests++;
    if (url.pathname === '/__health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, stats }));
      return;
    }
    const isAnthropic = url.pathname.startsWith('/anthropic');
    const path = isAnthropic ? url.pathname.replace(/^\/anthropic/, '') : url.pathname;
    const auth = req.headers.authorization || req.headers['x-api-key'] || req.headers['api-key'] || '';
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Missing upstream key', type: 'authentication_error' } }));
      return;
    }
    if (isAnthropic) stats.byProvider.anthropic++;
    else stats.byProvider.openai++;

    try {
      if (path === '/v1/models' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: ['gpt-4o', 'gpt-4o-mini', 'deepseek-chat', 'claude-3-5-sonnet'].map((id) => ({ id, object: 'model', owned_by: 'mock' })) }));
        return;
      }
      const body = await readBody(req);
      const azureMatch = /^\/azure\/openai\/deployments\/([^/]+)\/(chat\/completions|completions|embeddings)$/.exec(path);
      if (azureMatch) {
        body.model = body.model || decodeURIComponent(azureMatch[1]);
        if (azureMatch[2] === 'chat/completions') return await handleOpenAIChat(req, res, body);
        if (azureMatch[2] === 'completions') return await handleOpenAICompletions(req, res, body);
        return handleEmbeddings(req, res, body);
      }
      if (isAnthropic && path === '/v1/messages' && req.method === 'POST') return await handleAnthropicMessages(req, res, body);
      if (path === '/v1/chat/completions' && req.method === 'POST') return await handleOpenAIChat(req, res, body);
      if (path === '/v1/completions' && req.method === 'POST') return await handleOpenAICompletions(req, res, body);
      if (path === '/v1/embeddings' && req.method === 'POST') return handleEmbeddings(req, res, body);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Mock route not found: ${path}`, type: 'invalid_request_error' } }));
    } catch (err) {
      stats.errors++;
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'server_error' } }));
      } else {
        res.end();
      }
    }
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const actual = server.address();
      resolve({
        server,
        stats,
        port: actual.port,
        baseUrl: `http://${host}:${actual.port}`,
        close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.MOCK_PORT || 9900);
  const mock = await startMockUpstream({ port });
  console.log(`Mock upstream listening on ${mock.baseUrl}`);
  console.log(`  OpenAI-compatible base: ${mock.baseUrl}/v1`);
  console.log(`  Anthropic base:         ${mock.baseUrl}/anthropic`);
  console.log(`  Azure base:             ${mock.baseUrl}/azure`);
}
