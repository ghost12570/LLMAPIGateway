const ANTHROPIC_VERSION = '2023-06-01';

function textOf(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text || '';
      return '';
    }).join('');
  }
  return JSON.stringify(content);
}

function convertImage(part) {
  const url = part?.image_url?.url || '';
  if (!url) return null;
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s.exec(url);
  if (match) {
    const mediaType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return null;
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2] } };
  }
  return { type: 'image', source: { type: 'url', url } };
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools) {
    if (!tool || tool.type !== 'function' || !tool.function?.name) continue;
    converted.push({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} },
    });
  }
  return converted.length ? converted : undefined;
}

function convertToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'auto') return { type: 'auto' };
    if (choice === 'required' || choice === 'any') return { type: 'any' };
    if (choice === 'none') return { type: 'none' };
    return undefined;
  }
  if (choice.type === 'function' && choice.function?.name) {
    return { type: 'tool', name: choice.function.name };
  }
  return undefined;
}

function convertMessages(messages = []) {
  let system = '';
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'developer' ? 'system' : msg.role;
    if (role === 'system') {
      system += (system ? '\n\n' : '') + textOf(msg.content);
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const toolUseId = msg.tool_call_id || msg.name;
      const content = Array.isArray(msg.content)
        ? msg.content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
        : String(msg.content ?? '');
      push('user', [{ type: 'tool_result', tool_use_id: toolUseId, content }]);
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      if (msg.content) {
        const text = textOf(msg.content);
        if (text) blocks.push({ type: 'text', text });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const call of msg.tool_calls) {
          if (!call?.function?.name) continue;
          let input = {};
          try {
            input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            input = { _raw: call.function.arguments };
          }
          blocks.push({
            type: 'tool_use',
            id: call.id || `toolu_${Math.random().toString(36).slice(2, 12)}`,
            name: call.function.name,
            input,
          });
        }
      }
      push('assistant', blocks);
      continue;
    }
    if (role === 'user') {
      const blocks = [];
      if (typeof msg.content === 'string') {
        blocks.push({ type: 'text', text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'string') blocks.push({ type: 'text', text: part });
          else if (part?.type === 'text') blocks.push({ type: 'text', text: part.text || '' });
          else if (part?.type === 'image_url') {
            const image = convertImage(part);
            if (image) blocks.push(image);
          }
        }
      } else if (msg.content !== undefined && msg.content !== null) {
        blocks.push({ type: 'text', text: String(msg.content) });
      }
      push('user', blocks);
    }
  }

  // Anthropic requires the conversation to start with user and not be empty.
  if (!out.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Hello' }] });
  if (out[0].role !== 'user') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  }
  for (const m of out) {
    if (!m.content.length) m.content.push({ type: 'text', text: '.' });
  }
  return { system, messages: out };
}

function finishReason(reason) {
  switch (reason) {
    case 'max_tokens': return 'length';
    case 'tool_use': return 'tool_calls';
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    case 'refusal': return 'content_filter';
    default: return reason ? 'stop' : null;
  }
}

export const anthropicAdapter = {
  protocol: 'anthropic',

  buildRequest({ channel, upstreamModel, endpoint, body, stream, apiKey, targetModel }) {
    const base = String(channel.base_url || 'https://api.anthropic.com').replace(/\/+$/, '');
    const { system, messages } = convertMessages(body.messages || []);
    const payload = {
      model: upstreamModel,
      messages,
      max_tokens: Number(body.max_completion_tokens || body.max_tokens) || Math.min(Number(targetModel?.max_output_tokens) || 4096, 8192),
      stream: !!stream,
    };
    if (system) payload.system = system;
    if (body.temperature !== undefined) payload.temperature = Math.max(0, Math.min(1, Number(body.temperature)));
    if (body.top_p !== undefined) payload.top_p = Number(body.top_p);
    if (body.top_k !== undefined) payload.top_k = Number(body.top_k);
    if (body.stop !== undefined) payload.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];

    const tools = convertTools(body.tools);
    if (tools) payload.tools = tools;
    const choice = convertToolChoice(body.tool_choice);
    if (choice && choice.type !== 'none') payload.tool_choice = choice;
    if (choice?.type === 'none') delete payload.tools;

    if (body.response_format && body.response_format.type !== 'text') {
      payload.system = `${payload.system || ''}\n\nRespond only with a valid JSON value that satisfies the requested schema.`;
    }

    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...(channel.headers || {}),
    };

    return {
      url: `${base}/v1/messages`,
      headers,
      body: JSON.stringify(payload),
    };
  },

  normalizeResponse(json, ctx) {
    const usage = {
      prompt_tokens: Number(json.usage?.input_tokens) || 0,
      completion_tokens: Number(json.usage?.output_tokens) || 0,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    ctx.usage = usage;

    const texts = [];
    const toolCalls = [];
    for (const block of json.content || []) {
      if (block.type === 'text') texts.push(block.text);
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
        });
      } else if (block.type === 'thinking' && block.thinking) {
        texts.push('');
      }
    }
    const content = texts.join('') || null;

    if (ctx.endpoint === 'completions') {
      return {
        id: `cmpl-${json.id || ctx.id}`,
        object: 'text_completion',
        created: Math.floor(ctx.created / 1000),
        model: ctx.alias,
        choices: [{ text: content || '', index: 0, logprobs: null, finish_reason: finishReason(json.stop_reason) }],
        usage,
      };
    }

    const message = { role: 'assistant', content };
    if (toolCalls.length) message.tool_calls = toolCalls;
    return {
      id: json.id ? `chatcmpl-${json.id}` : (ctx.chatId || ctx.id),
      object: 'chat.completion',
      created: Math.floor(ctx.created / 1000),
      model: ctx.alias,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason(json.stop_reason) }],
      usage,
    };
  },

  async *streamTransform(response, ctx) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const state = {
      id: ctx.chatId || `chatcmpl-${ctx.id}`,
      created: Math.floor(ctx.created / 1000),
      model: ctx.alias,
      inputTokens: 0,
      outputTokens: 0,
      toolIndexByBlock: new Map(),
      toolCount: 0,
      finish: null,
      first: true,
    };
    const chunk = (delta, finishReasonValue = null, extra = {}) => ({
      id: state.id,
      object: 'chat.completion.chunk',
      created: state.created,
      model: state.model,
      choices: [{ index: 0, delta, finish_reason: finishReasonValue, logprobs: null }],
      ...extra,
    });

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payloadText = line.slice(5).trim();
        if (!payloadText) continue;
        let ev;
        try { ev = JSON.parse(payloadText); } catch { continue; }
        if (ev.type === 'message_start') {
          state.inputTokens = Number(ev.message?.usage?.input_tokens) || 0;
        }
        if (state.first) {
          state.first = false;
          yield chunk({ role: 'assistant', content: '' });
        }
        if (ev.type === 'content_block_start') {
          const block = ev.content_block || {};
          if (block.type === 'tool_use') {
            const toolIndex = state.toolCount++;
            state.toolIndexByBlock.set(ev.index, toolIndex);
            yield chunk({
              tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }],
            });
          } else if (block.type === 'thinking') {
            yield chunk({ reasoning_content: block.thinking || '' });
          }
        } else if (ev.type === 'content_block_delta') {
          const delta = ev.delta || {};
          if (delta.type === 'text_delta') {
            yield chunk({ content: delta.text || '' });
          } else if (delta.type === 'input_json_delta') {
            const toolIndex = state.toolIndexByBlock.get(ev.index) ?? 0;
            yield chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json || '' } }] });
          } else if (delta.type === 'thinking_delta') {
            yield chunk({ reasoning_content: delta.thinking || '' });
          }
        } else if (ev.type === 'message_delta') {
          state.outputTokens = Number(ev.usage?.output_tokens) || state.outputTokens;
          state.finish = ev.delta?.stop_reason || state.finish;
          if (state.finish) yield chunk({}, finishReason(state.finish));
        } else if (ev.type === 'error') {
          throw new Error(ev.error?.message || 'Anthropic stream error');
        }
      }
    }

    ctx.usage = {
      prompt_tokens: state.inputTokens,
      completion_tokens: state.outputTokens,
      total_tokens: state.inputTokens + state.outputTokens,
    };
    if (!state.finish) yield chunk({}, 'stop');
  },

  probe({ channel, apiKey }) {
    const base = String(channel.base_url || 'https://api.anthropic.com').replace(/\/+$/, '');
    return {
      url: `${base}/v1/models`,
      init: {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          ...(channel.headers || {}),
        },
      },
    };
  },
};

export { convertMessages as anthropicConvertMessages, finishReason as anthropicFinishReason };
