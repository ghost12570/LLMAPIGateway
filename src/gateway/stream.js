import { GatewayError, upstreamFailure, upstreamTimeout } from '../util/errors.js';
import { startSse } from '../util/http.js';
import { OutputMeter } from '../util/tokenizer.js';

export class ClientAbortError extends Error {
  constructor() {
    super('client disconnected');
    this.name = 'ClientAbortError';
  }
}

function isAbortError(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

function waitForDrain(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new ClientAbortError()); };
    const onError = (err) => { cleanup(); reject(err); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (res.destroyed) onClose();
  });
}

async function writeRaw(res, text) {
  if (res.writableEnded || res.destroyed) throw new ClientAbortError();
  if (!res.write(text)) await waitForDrain(res);
}

function normalizeUsage(u) {
  if (!u || typeof u !== 'object') return null;
  const hasPrompt = u.prompt_tokens !== undefined || u.input_tokens !== undefined;
  const hasCompletion = u.completion_tokens !== undefined || u.output_tokens !== undefined;
  if (!hasPrompt && !hasCompletion) return null;
  const p = Number(u.prompt_tokens ?? u.input_tokens) || 0;
  const c = Number(u.completion_tokens ?? u.output_tokens) || 0;
  const total = Number(u.total_tokens) || p + c;
  return { prompt_tokens: p, completion_tokens: c, total_tokens: total };
}

function finalUsage(upstreamUsage, promptTokens, meter) {
  if (upstreamUsage && (upstreamUsage.prompt_tokens > 0 || upstreamUsage.completion_tokens > 0)) {
    const prompt = upstreamUsage.prompt_tokens || promptTokens;
    const completion = upstreamUsage.completion_tokens || meter.tokens;
    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      estimated: !upstreamUsage.prompt_tokens,
    };
  }
  const prompt = promptTokens;
  const completion = upstreamUsage?.completion_tokens || meter.tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    estimated: true,
  };
}

function sseData(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function usageChunk(ctx, usage, legacy = false) {
  return {
    id: ctx.chatId || ctx.id,
    object: legacy ? 'text_completion' : 'chat.completion.chunk',
    created: Math.floor(ctx.created / 1000),
    model: ctx.alias,
    choices: [],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
  };
}

function updateStats(obj, state) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.usage) {
    const u = normalizeUsage(obj.usage);
    if (u) state.usage = u;
  }
  const choice = obj.choices?.[0];
  if (choice?.text) state.meter.add(choice.text);
  if (choice?.delta) {
    if (choice.delta.content) state.meter.add(choice.delta.content);
    if (choice.delta.reasoning_content) state.meter.add(choice.delta.reasoning_content);
    if (Array.isArray(choice.delta.tool_calls)) {
      for (const call of choice.delta.tool_calls) {
        if (call?.function?.arguments) state.meter.add(call.function.arguments);
        if (call?.function?.name) state.meter.add(call.function.name);
      }
    }
  }
  if (choice?.finish_reason) state.finishReason = choice.finish_reason;
}

function streamErrorFromObject(obj) {
  const err = obj?.error;
  if (!err) return null;
  const message = typeof err === 'string' ? err : err.message || err.code || 'Upstream stream error';
  const code = err.code || 'upstream_stream_error';
  const type = err.type || 'upstream_error';
  const status = Number(err.code) >= 400 && Number(err.code) < 600 ? Number(err.code) : 502;
  return new GatewayError(message, { status, type, code });
}

function buildErrorOutcome(err, state, startedAt) {
  return {
    status: err instanceof ClientAbortError ? 'cancelled' : 'error',
    error: err,
    ttft_ms: state.ttftMs ?? null,
    usage: finalUsage(state.usage, state.promptTokens, state.meter),
    finish_reason: state.finishReason,
    started_at: startedAt,
  };
}

function buildSuccessOutcome(state, startedAt) {
  return {
    status: 'success',
    error: null,
    ttft_ms: state.ttftMs ?? null,
    usage: finalUsage(state.usage, state.promptTokens, state.meter),
    finish_reason: state.finishReason,
    started_at: startedAt,
  };
}

async function trySendStreamError(res, err) {
  if (!res.headersSent || res.writableEnded || res.destroyed) return;
  try {
    await writeRaw(res, sseData(err.toJSON ? err.toJSON() : {
      error: { message: err.message, type: 'upstream_error', code: 502 },
    }));
  } catch {
    /* client already gone */
  }
  try { res.end(); } catch { /* ignore */ }
}

/**
 * OpenAI-compatible SSE pass-through. Writes only complete SSE lines, forwards them immediately,
 * inspects chunks for usage/usage estimation, and guarantees a usage chunk before [DONE].
 */
export async function passthroughStream({
  response, res, controller, channel, ctx, headers, promptTokens, promptEstimated, settings, state, startedAt,
}) {
  if (!response.body) throw upstreamFailure('Upstream returned an empty streaming body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const heartbeatMs = settings.getNumber('sse.heartbeat_ms', 15000);
  const localState = {
    usage: null,
    meter: new OutputMeter(),
    finishReason: null,
    promptTokens,
    ttftMs: null,
  };
  let headersStarted = false;
  let heartbeat = null;
  let lastWrite = Date.now();
  let pending = '';
  let done = false;
  let receivedFirstChunk = false;
  let usageForwarded = false;

  const firstByteTimer = setTimeout(() => {
    state.timedOut = 'first_byte';
    controller.abort();
  }, Math.max(1000, Number(channel.first_byte_timeout_ms) || 30000));

  function startHeaders() {
    if (headersStarted) return;
    headersStarted = true;
    clearTimeout(firstByteTimer);
    startSse(res, headers);
    localState.ttftMs = Date.now() - startedAt;
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        if (Date.now() - lastWrite >= heartbeatMs) {
          lastWrite = Date.now();
          res.write(': ping\n\n');
        }
      }, Math.max(1000, Math.floor(heartbeatMs / 2)));
      heartbeat.unref?.();
    }
  }

  async function emitText(text) {
    if (!text) return;
    startHeaders();
    lastWrite = Date.now();
    await writeRaw(res, text);
  }

  function processLine(line) {
    if (line.startsWith('data:')) {
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        const usage = finalUsage(localState.usage, promptTokens, localState.meter);
        let out = '';
        if (!usageForwarded) out += sseData(usageChunk(ctx, usage));
        out += 'data: [DONE]\n\n';
        done = true;
        return { text: out, done: true, usage };
      }
      if (payload) {
        let obj;
        try { obj = JSON.parse(payload); } catch { obj = null; }
        if (obj) {
          const streamErr = streamErrorFromObject(obj);
          if (streamErr) throw streamErr;
          updateStats(obj, localState);
          if (obj.usage && normalizeUsage(obj.usage)) usageForwarded = true;
          if (Object.prototype.hasOwnProperty.call(obj, 'model') && obj.model !== ctx.alias) {
            obj.model = ctx.alias;
            return { text: `data: ${JSON.stringify(obj)}\n`, done: false };
          }
        }
      }
      return { text: line + '\n', done: false };
    }
    return { text: line + '\n', done: false };
  }

  try {
    while (!done) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (state.clientAborted) return buildErrorOutcome(new ClientAbortError(), localState, startedAt);
        if (isAbortError(err) || controller.signal.aborted) {
          if (!headersStarted) {
            if (state.timedOut === 'first_byte') {
              throw upstreamTimeout(`Upstream did not send any data within ${channel.first_byte_timeout_ms || 30000}ms`);
            }
            throw upstreamTimeout('Upstream streaming request timed out');
          }
          const timeoutErr = upstreamTimeout('Upstream stream timed out during generation');
          await trySendStreamError(res, timeoutErr);
          return buildErrorOutcome(timeoutErr, localState, startedAt);
        }
        if (!headersStarted) throw upstreamFailure(`Upstream stream failed: ${err.message}`);
        await trySendStreamError(res, upstreamFailure(`Upstream connection reset during generation: ${err.message}`));
        return buildErrorOutcome(upstreamFailure(`Upstream connection reset during generation: ${err.message}`), localState, startedAt);
      }

      if (!receivedFirstChunk) {
        receivedFirstChunk = true;
        clearTimeout(firstByteTimer);
      }
      if (chunk.done) {
        if (!done) {
          if (pending) {
            const action = processLine(pending.replace(/\r$/, ''));
            pending = '';
            if (action.text) await emitText(action.text);
            if (action.done) done = true;
          }
          if (!done) {
            const usage = finalUsage(localState.usage, promptTokens, localState.meter);
            let out = '';
            if (!usageForwarded) out += sseData(usageChunk(ctx, usage));
            out += 'data: [DONE]\n\n';
            await emitText(out);
            done = true;
          }
        }
        break;
      }

      pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 8 * 1024 * 1024) {
        throw upstreamFailure('Upstream SSE line exceeds the 8MB safety limit');
      }
      let nl;
      while (!done && (nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        const action = processLine(line);
        if (action.text) await emitText(action.text);
        if (action.done) {
          done = true;
          break;
        }
      }
    }
    if (!headersStarted) {
      // Empty stream: still return a well-formed SSE response.
      startHeaders();
      const usage = finalUsage(localState.usage, promptTokens, localState.meter);
      await emitText(sseData(usageChunk(ctx, usage)) + 'data: [DONE]\n\n');
    }
    if (!res.writableEnded) res.end();
    return buildSuccessOutcome(localState, startedAt);
  } catch (err) {
    if (state.clientAborted || err instanceof ClientAbortError) {
      return buildErrorOutcome(new ClientAbortError(), localState, startedAt);
    }
    if (!headersStarted) {
      throw err instanceof GatewayError ? err : upstreamFailure(err.message);
    }
    const mapped = err instanceof GatewayError ? err : upstreamFailure(err.message);
    await trySendStreamError(res, mapped);
    return buildErrorOutcome(mapped, localState, startedAt);
  } finally {
    clearTimeout(firstByteTimer);
    if (heartbeat) clearInterval(heartbeat);
    try { await reader.cancel(); } catch { /* ignore */ }
  }
}

function legacyChunk(chunk) {
  if (!chunk || !Array.isArray(chunk.choices)) return chunk;
  if (!chunk.choices.length) return { ...chunk, object: 'text_completion' };
  return {
    id: chunk.id,
    object: 'text_completion',
    created: chunk.created,
    model: chunk.model,
    choices: chunk.choices.map((c) => ({
      text: c.delta?.content || '',
      index: c.index ?? 0,
      logprobs: null,
      finish_reason: c.finish_reason ?? null,
    })),
  };
}

/** Transform an adapter's OpenAI-shaped async chunk generator into an SSE response. */
export async function transformedStream({
  adapter, response, res, controller, channel, ctx, headers, promptTokens, settings, state, startedAt,
}) {
  const heartbeatMs = settings.getNumber('sse.heartbeat_ms', 15000);
  const generator = adapter.streamTransform(response, ctx);
  const localState = { usage: null, meter: new OutputMeter(), finishReason: null, promptTokens, ttftMs: null };
  const legacy = ctx.endpoint === 'completions';
  let headersStarted = false;
  let heartbeat = null;
  let lastWrite = Date.now();

  const firstByteTimer = setTimeout(() => {
    state.timedOut = 'first_byte';
    controller.abort();
  }, Math.max(1000, Number(channel.first_byte_timeout_ms) || 30000));

  function startHeaders() {
    if (headersStarted) return;
    headersStarted = true;
    clearTimeout(firstByteTimer);
    startSse(res, headers);
    localState.ttftMs = Date.now() - startedAt;
    if (heartbeatMs > 0) {
      heartbeat = setInterval(() => {
        if (res.writableEnded || res.destroyed) return;
        if (Date.now() - lastWrite >= heartbeatMs) {
          lastWrite = Date.now();
          res.write(': ping\n\n');
        }
      }, Math.max(1000, Math.floor(heartbeatMs / 2)));
      heartbeat.unref?.();
    }
  }

  async function writeChunkObject(obj) {
    let out = obj;
    if (legacy) out = legacyChunk(obj);
    const text = sseData(out);
    startHeaders();
    lastWrite = Date.now();
    await writeRaw(res, text);
  }

  try {
    let next;
    try {
      next = await generator.next();
    } catch (err) {
      if (state.clientAborted) return buildErrorOutcome(new ClientAbortError(), localState, startedAt);
      if (isAbortError(err) || controller.signal.aborted) {
        if (state.timedOut === 'first_byte') {
          throw upstreamTimeout(`Upstream did not send any data within ${channel.first_byte_timeout_ms || 30000}ms`);
        }
        throw upstreamTimeout('Upstream streaming request timed out');
      }
      throw upstreamFailure(`Upstream stream failed: ${err.message}`);
    }

    while (!next.done) {
      const chunk = next.value;
      updateStats(chunk, localState);
      await writeChunkObject(chunk);
      try {
        next = await generator.next();
      } catch (err) {
        if (state.clientAborted) return buildErrorOutcome(new ClientAbortError(), localState, startedAt);
        const mapped = isAbortError(err) || controller.signal.aborted
          ? upstreamTimeout('Upstream stream timed out during generation')
          : upstreamFailure(`Upstream connection reset during generation: ${err.message}`);
        await trySendStreamError(res, mapped);
        return buildErrorOutcome(mapped, localState, startedAt);
      }
    }

    const usage = finalUsage(ctx.usage || localState.usage, promptTokens, localState.meter);
    const usageObj = usageChunk(ctx, usage, legacy);
    await writeChunkObject(usageObj);
    await writeRaw(res, 'data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
    localState.usage = usage;
    return buildSuccessOutcome(localState, startedAt);
  } catch (err) {
    if (state.clientAborted || err instanceof ClientAbortError) {
      return buildErrorOutcome(new ClientAbortError(), localState, startedAt);
    }
    if (!headersStarted) throw err instanceof GatewayError ? err : upstreamFailure(err.message);
    const mapped = err instanceof GatewayError ? err : upstreamFailure(err.message);
    await trySendStreamError(res, mapped);
    return buildErrorOutcome(mapped, localState, startedAt);
  } finally {
    clearTimeout(firstByteTimer);
    if (heartbeat) clearInterval(heartbeat);
  }
}

export { writeRaw, sseData, normalizeUsage };
