import { getAdapter } from '../providers/index.js';
import { passthroughStream, transformedStream, ClientAbortError } from './stream.js';
import {
  GatewayError, badRequest, forbidden, mapUpstreamError, noChannel, quotaExceeded,
  rateLimited, upstreamFailure, upstreamTimeout,
} from '../util/errors.js';
import {
  estimateChatPromptTokens, estimateCompletionTokens, estimateTextTokens,
} from '../util/tokenizer.js';
import { sendJson } from '../util/http.js';

async function readLimited(body, maxBytes) {
  if (!body) return '';
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw upstreamFailure('Upstream response exceeds the allowed size');
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function truncate(text, len = 500) {
  if (!text) return null;
  const clean = String(text).replace(/[\r\n]+/g, ' ').slice(0, len);
  return clean;
}

function estimateInputTokens(endpoint, body) {
  if (endpoint === 'chat') return estimateChatPromptTokens(body.messages, body.tools);
  if (endpoint === 'completions') {
    const prompt = body.prompt;
    if (Array.isArray(prompt)) return prompt.reduce((sum, p) => sum + estimateTextTokens(String(p)), 0);
    return estimateTextTokens(String(prompt || ''));
  }
  const input = body.input;
  if (Array.isArray(input)) return input.reduce((sum, i) => sum + estimateTextTokens(typeof i === 'string' ? i : JSON.stringify(i)), 0);
  return estimateTextTokens(String(input || ''));
}

function computeUsage(json, endpoint, promptEstimate) {
  const up = json?.usage || {};
  let prompt = Number(up.prompt_tokens ?? up.input_tokens);
  let completion = Number(up.completion_tokens ?? up.output_tokens);
  let estimated = false;
  if (!Number.isFinite(prompt)) {
    prompt = promptEstimate;
    estimated = true;
  }
  if (!Number.isFinite(completion)) {
    if (endpoint === 'embeddings') completion = 0;
    else completion = estimateCompletionTokens(json?.choices);
    estimated = true;
  }
  prompt = Math.max(0, Math.round(prompt));
  completion = Math.max(0, Math.round(completion));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, estimated };
}

function publicUsage(usage) {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
  };
}

function circuitKind(err) {
  if (err.code === 'gateway_timeout') return 'timeout';
  if (err.code === 'upstream_rate_limit') return 'upstream_rate_limit';
  if (err.code === 'upstream_auth_error') return 'upstream_auth_error';
  if (/connection|fetch|socket|ECONN|ENOTFOUND|EPIPE/i.test(err.message || '')) return 'network';
  return 'upstream_error';
}

function shouldCountAsChannelFailure(err) {
  if (!err) return false;
  if (['invalid_request_error', 'payload_too_large', 'model_not_found', 'context_length_exceeded'].includes(err.code)) return false;
  if (err.status === 400 || err.status === 413) return false;
  return true;
}

export class GatewayEngine {
  constructor({ db, config, settings, quota, limiter, circuits, metrics, logStore, routing, alerts }) {
    this.db = db;
    this.config = config;
    this.settings = settings;
    this.quota = quota;
    this.limiter = limiter;
    this.circuits = circuits;
    this.metrics = metrics;
    this.logStore = logStore;
    this.routing = routing;
    this.alerts = alerts;
  }

  validate(endpoint, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
    if (!body.model || typeof body.model !== 'string') throw badRequest('The "model" field is required', 'missing_model');
    if (endpoint === 'chat') {
      if (!Array.isArray(body.messages) || body.messages.length === 0) throw badRequest('The "messages" field must be a non-empty array', 'invalid_messages');
      for (const msg of body.messages) {
        if (!msg || typeof msg !== 'object' || !msg.role) throw badRequest('Each message must have a role and content', 'invalid_messages');
      }
    } else if (endpoint === 'completions') {
      if (body.prompt === undefined || body.prompt === null) throw badRequest('The "prompt" field is required', 'invalid_prompt');
    } else if (endpoint === 'embeddings') {
      if (body.input === undefined || body.input === null) throw badRequest('The "input" field is required', 'invalid_input');
    }
    if (body.stream !== undefined && typeof body.stream !== 'boolean') throw badRequest('The "stream" field must be a boolean', 'invalid_stream');
  }

  capabilityFor(endpoint) {
    return endpoint === 'embeddings' ? 'embedding' : 'chat';
  }

  async execute(req, res, { endpoint, body, ctx, requestId }) {
    const startedAt = Date.now();
    this.metrics.begin();
    const state = {
      status: 'error',
      httpStatus: 500,
      usage: null,
      cost: 0,
      estimated: false,
      error: null,
      ttft: null,
      attempts: 0,
      channel: null,
      provider: null,
      upstreamModel: null,
      targetAlias: null,
      reservation: false,
      settled: false,
      clientAborted: false,
      timedOut: null,
      requestId,
    };
    let requestedAlias = typeof body?.model === 'string' ? body.model : 'unknown';
    let promptEstimate = 0;
    let stream = false;

    const headersFor = (candidate) => ({
      'X-Request-Id': requestId,
      'X-Gateway-Request-Id': requestId,
      ...(candidate ? {
        'X-Gateway-Channel': candidate.channel.id,
        'X-Gateway-Provider': candidate.channel.provider,
        'X-Gateway-Model': candidate.alias,
        'X-Gateway-Attempts': String(state.attempts),
      } : {}),
    });

    try {
      this.validate(endpoint, body);
      requestedAlias = body.model;
      stream = body.stream === true && endpoint !== 'embeddings';

      if (endpoint === 'embeddings' && body.stream === true) throw badRequest('Embeddings do not support streaming', 'invalid_stream');

      const allowed = ctx.key?.allowed_models;
      if (Array.isArray(allowed) && allowed.length && !allowed.includes('*') && !allowed.includes(requestedAlias)) {
        throw forbidden(`This API key is not authorized to use model '${requestedAlias}'`, 'model_not_allowed');
      }

      const cap = this.capabilityFor(endpoint);
      const resolved = this.routing.resolveCandidates({
        requested: requestedAlias,
        body,
        allowedModels: Array.isArray(allowed) && !allowed.includes('*') ? allowed : null,
        capability: cap,
      });
      const candidates = resolved.candidates;
      promptEstimate = estimateInputTokens(endpoint, body);

      const contextWindow = Number(candidates[0].targetModel.context_window) || 0;
      if (contextWindow > 0 && promptEstimate > contextWindow) {
        const larger = this.routing.loadSnapshot().models;
        let suggestion = '';
        for (const m of larger.values()) {
          if (m.visible && m.context_window > promptEstimate) {
            suggestion = ` Try model '${m.alias}' with a ${m.context_window} token context window.`;
            break;
          }
        }
        throw new GatewayError(
          `This model's maximum context length is ${contextWindow} tokens, but the request contains approximately ${promptEstimate} tokens.${suggestion}`,
          { status: 400, type: 'invalid_request_error', code: 'context_length_exceeded' },
        );
      }

      const reserveCompletion = Math.max(32, this.settings.getNumber('limits.min_completion_reserve', 256));
      const rate = this.limiter.check(ctx.rateLimitId, ctx.key, promptEstimate + reserveCompletion);
      if (!rate.ok) {
        throw rateLimited(
          rate.reason === 'qps'
            ? `Request rate limit exceeded (${rate.qps} req/s). Please retry in ${rate.retryAfter}s.`
            : `Token rate limit exceeded (${rate.tpm} tokens/min). Please retry in ${rate.retryAfter}s.`,
          rate.retryAfter,
        );
      }

      const maxInput = Math.max(...candidates.map((c) => Number(c.targetModel.input_price) || 0));
      const maxOutput = Math.max(...candidates.map((c) => Number(c.targetModel.output_price) || 0));
      const estimateCost = this.quota.estimateCost(
        { input_price: maxInput, output_price: maxOutput },
        promptEstimate,
        reserveCompletion,
      );
      const reserved = this.quota.reserve(ctx, requestId, estimateCost);
      if (!reserved.ok) {
        throw quotaExceeded(reserved.message || 'Insufficient quota for this request');
      }
      state.reservation = true;

      const adapterCtx = {
        id: requestId,
        chatId: `chatcmpl-${requestId.replace(/^req_/, '')}`,
        alias: requestedAlias,
        created: startedAt,
        endpoint,
      };

      let lastError = null;
      for (const candidate of candidates) {
        if (state.clientAborted) break;
        if (!this.circuits.canAttempt(candidate.channel.id)) continue;
        if (!this.routing.slotAvailable(candidate.channel)) continue;
        if (this.circuits.get(candidate.channel.id).state === 'half_open') {
          this.circuits.markTrial(candidate.channel.id);
        }
        delete adapterCtx.usage;

        this.routing.acquireSlot(candidate.channel.id);
        state.attempts++;
        state.channel = candidate.channel;
        state.provider = candidate.channel.provider;
        state.upstreamModel = candidate.upstreamModel;
        state.targetAlias = candidate.alias;

        const controller = new AbortController();
        const onResClose = () => {
          if (!res.writableFinished) {
            state.clientAborted = true;
            controller.abort();
          }
        };
        res.once('close', onResClose);
        const deadline = setTimeout(() => {
          state.timedOut = 'total';
          controller.abort();
        }, Math.max(1000, Number(candidate.channel.timeout_ms) || 60000));

        try {
          const adapter = getAdapter(candidate.channel.provider);
          const built = adapter.buildRequest({
            channel: candidate.channel,
            upstreamModel: candidate.upstreamModel,
            endpoint,
            body,
            stream,
            apiKey: candidate.key.key,
            targetModel: candidate.targetModel,
          });

          let upstream;
          try {
            upstream = await fetch(built.url, {
              method: 'POST',
              headers: built.headers,
              body: built.body,
              signal: controller.signal,
              redirect: 'follow',
            });
          } catch (err) {
            if (state.clientAborted) throw new ClientAbortError();
            if (state.timedOut || err.name === 'AbortError') {
              throw upstreamTimeout(`Upstream request timed out after ${candidate.channel.timeout_ms || 60000}ms`);
            }
            throw upstreamFailure(`Upstream connection failed: ${err.cause?.code || err.message}`);
          }

          if (!upstream.ok) {
            let text = '';
            try { text = await readLimited(upstream.body, 256 * 1024); } catch { /* ignore */ }
            const mapped = mapUpstreamError(upstream.status, text, candidate.channel.provider);
            if (upstream.status === 401 || upstream.status === 403) mapped.retryable = true;
            throw mapped;
          }

          if (stream) {
            const contentType = upstream.headers.get('content-type') || '';
            if (!/text\/event-stream/i.test(contentType)) {
              let text = '';
              try { text = (await readLimited(upstream.body, 8192)).slice(0, 500); } catch { /* ignore */ }
              throw upstreamFailure(`Upstream did not return an event stream (content-type: ${contentType || 'unknown'}): ${text}`);
            }
            const headers = headersFor(candidate);
            const streamArgs = {
              response: upstream,
              res,
              controller,
              channel: candidate.channel,
              ctx: adapterCtx,
              headers,
              promptTokens: promptEstimate,
              promptEstimated: true,
              settings: this.settings,
              state,
              startedAt,
            };
            const outcome = adapter.protocol === 'anthropic'
              ? await transformedStream({ ...streamArgs, adapter })
              : await passthroughStream(streamArgs);

            state.ttft = outcome.ttft_ms;
            state.usage = outcome.usage;
            state.estimated = !!outcome.usage?.estimated;

            if (outcome.status === 'success') {
              this.settle(ctx, candidate, state, requestId);
              this.circuits.onSuccess(candidate.channel.id, Date.now() - startedAt);
              state.status = 'success';
              state.httpStatus = 200;
              state.error = null;
              return;
            }
            if (outcome.status === 'cancelled') {
              if (outcome.usage?.completion_tokens > 0) this.settle(ctx, candidate, state, requestId);
              state.status = 'cancelled';
              state.httpStatus = 499;
              return;
            }

            state.status = 'error';
            state.httpStatus = outcome.error?.status || 502;
            state.error = outcome.error || upstreamFailure('Upstream stream failed');
            if (outcome.usage?.completion_tokens > 0) this.settle(ctx, candidate, state, requestId);
            this.circuits.onFailure(candidate.channel.id, circuitKind(state.error), state.error.message, Date.now() - startedAt);
            return;
          }

          const text = await readLimited(upstream.body, 64 * 1024 * 1024);
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            throw upstreamFailure('Upstream returned a non-JSON response');
          }
          if (json?.error) {
            throw mapUpstreamError(502, JSON.stringify(json), candidate.channel.provider);
          }

          const normalized = adapter.normalizeResponse(json, adapterCtx);
          const expected = endpoint === 'embeddings' ? normalized?.data : normalized?.choices;
          if (!Array.isArray(expected)) {
            throw upstreamFailure('Upstream returned an invalid response shape');
          }
          const usage = computeUsage(normalized, endpoint, promptEstimate);
          normalized.usage = publicUsage(usage);
          state.usage = usage;
          state.estimated = usage.estimated;

          this.settle(ctx, candidate, state, requestId);
          this.circuits.onSuccess(candidate.channel.id, Date.now() - startedAt);
          state.status = 'success';
          state.httpStatus = 200;
          state.error = null;

          sendJson(res, 200, normalized, headersFor(candidate));
          return;
        } catch (err) {
          if (state.clientAborted || err instanceof ClientAbortError) {
            state.status = 'cancelled';
            state.httpStatus = 499;
            return;
          }
          const mapped = this.normalizeError(err, state);
          state.error = mapped;
          state.httpStatus = mapped.status;
          lastError = mapped;

          if (shouldCountAsChannelFailure(mapped)) {
            this.circuits.onFailure(candidate.channel.id, circuitKind(mapped), mapped.message, Date.now() - startedAt);
          }

          const canRetry = mapped.retryable && state.attempts < candidates.length;
          if (!canRetry) throw mapped;
        } finally {
          clearTimeout(deadline);
          res.removeListener('close', onResClose);
          this.routing.releaseSlot(candidate.channel.id);
        }
      }

      if (state.clientAborted) {
        state.status = 'cancelled';
        state.httpStatus = 499;
        return;
      }
      throw lastError || noChannel(`No healthy upstream channel is currently available for model '${requestedAlias}'.`);
    } catch (err) {
      if (state.clientAborted || err instanceof ClientAbortError) {
        state.status = 'cancelled';
        state.httpStatus = 499;
      } else {
        const mapped = this.normalizeError(err, state);
        state.status = 'error';
        state.httpStatus = mapped.status;
        state.error = mapped;
        if (!res.headersSent && !res.writableEnded) {
          sendJson(res, mapped.status, mapped.toJSON(), {
            ...mapped.headers,
            'X-Request-Id': requestId,
            'X-Gateway-Request-Id': requestId,
          });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    } finally {
      if (state.reservation && !state.settled) {
        this.quota.release(requestId);
        state.reservation = false;
      }
      if (state.usage?.total_tokens > 0 && ctx?.rateLimitId) {
        this.limiter.recordTokens(ctx.rateLimitId, state.usage.total_tokens);
      }
      this.logStore.record({
        id: requestId,
        ts: startedAt,
        user_id: ctx?.user?.id || null,
        org_id: ctx?.user?.org_id || null,
        key_id: ctx?.playground ? null : ctx?.key?.id || null,
        source: ctx?.source || 'api',
        endpoint,
        model: requestedAlias,
        upstream_model: state.upstreamModel,
        channel_id: state.channel?.id || null,
        provider: state.provider,
        stream,
        status: state.status,
        http_status: state.httpStatus,
        latency_ms: Date.now() - startedAt,
        ttft_ms: state.ttft,
        prompt_tokens: state.usage?.prompt_tokens || 0,
        completion_tokens: state.usage?.completion_tokens || 0,
        total_tokens: state.usage?.total_tokens || 0,
        estimated: !!state.estimated,
        cost_usd: state.cost,
        error_type: state.error?.type || null,
        error_code: state.error?.code || null,
        error_message: truncate(state.error?.message),
        attempts: state.attempts,
        client_ip: ctx?.ip || null,
      });
      this.metrics.record({
        status: state.status,
        latencyMs: Date.now() - startedAt,
        ttftMs: state.ttft,
        tokens: state.usage?.total_tokens || 0,
        cost: state.cost,
        model: requestedAlias,
        provider: state.provider,
        channelId: state.channel?.id,
        stream,
      });
      this.metrics.end();
    }
  }

  settle(ctx, candidate, state, requestId) {
    const usage = state.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const cost = this.quota.estimateCost(candidate.targetModel, usage.prompt_tokens, usage.completion_tokens);
    this.quota.settle(ctx, requestId, cost, {
      model: candidate.alias,
      requested: candidate.alias,
      status: state.status,
    });
    state.cost = cost;
    state.settled = true;
    state.reservation = false;
  }

  normalizeError(err, state) {
    if (err instanceof GatewayError) return err;
    if (err instanceof ClientAbortError) {
      return new GatewayError('Client disconnected', { status: 499, type: 'gateway_error', code: 'client_closed' });
    }
    if (state.timedOut || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      return upstreamTimeout('Upstream request timed out');
    }
    return new GatewayError(err?.message || 'Gateway internal error', {
      status: 500, type: 'gateway_error', code: 'internal_error',
    });
  }

  listModelsForContext(ctx, { onlyAvailable = false } = {}) {
    const snap = this.routing.loadSnapshot();
    const allowed = ctx.key?.allowed_models;
    const restrict = Array.isArray(allowed) && allowed.length && !allowed.includes('*');
    const smart = this.settings.getJSON('smart_routes', {});
    const out = [];
    for (const model of snap.models.values()) {
      if (!model.visible) continue;
      if (restrict && !allowed.includes(model.alias)) continue;
      let status;
      if (model.kind === 'router') {
        const groups = smart.groups || {};
        let targets;
        if (model.smart_group === 'auto') {
          targets = [...new Set(Object.values(groups).flat())];
        } else {
          targets = groups[model.smart_group] || [];
        }
        targets = targets.filter((a) => snap.models.get(a)?.visible);
        const available = targets.some((a) => this.routing.modelStatus(a).available);
        const channels = targets.reduce((sum, a) => sum + this.routing.modelStatus(a).channel_count, 0);
        status = { available, channel_count: channels, healthy_channels: available ? 1 : 0 };
      } else {
        status = this.routing.modelStatus(model.alias);
      }
      if (onlyAvailable && !status.available) continue;
      out.push({
        id: model.alias,
        object: 'model',
        created: Math.floor((model.created_at || Date.now()) / 1000),
        owned_by: 'llm-gateway',
        name: model.name,
        description: model.description,
        context_window: model.context_window,
        max_output_tokens: model.max_output_tokens,
        capabilities: model.capabilities,
        kind: model.kind,
        pricing: {
          input_per_1k: model.input_price,
          output_per_1k: model.output_price,
          currency: 'USD',
          unit: '1K tokens',
        },
        fallback_chain: model.fallback_chain,
        available: status.available,
        channel_count: status.channel_count,
      });
    }
    return { object: 'list', data: out };
  }

  getModelForContext(ctx, id) {
    const list = this.listModelsForContext(ctx, { onlyAvailable: true });
    return list.data.find((m) => m.id === id) || null;
  }
}
