const PATHS = {
  chat: '/chat/completions',
  completions: '/completions',
  embeddings: '/embeddings',
  models: '/models',
};

function trimBase(base) {
  return String(base || '').replace(/\/+$/, '');
}

export function joinUrl(base, path) {
  return `${trimBase(base)}${path}`;
}

export const openaiAdapter = {
  protocol: 'openai',

  buildRequest({ channel, upstreamModel, endpoint, body, stream, apiKey }) {
    const isAzure = channel.provider === 'azure';
    let url;
    if (isAzure) {
      const base = trimBase(channel.base_url);
      const prefix = /\/openai$/.test(base) ? base : `${base}/openai`;
      const path = PATHS[endpoint] || PATHS.chat;
      const version = channel.api_version || '2024-06-01';
      url = `${prefix}/deployments/${encodeURIComponent(upstreamModel)}${path}?api-version=${encodeURIComponent(version)}`;
    } else {
      url = joinUrl(channel.base_url, PATHS[endpoint] || PATHS.chat);
    }

    const payload = { ...body, stream: !!stream };
    if (isAzure) delete payload.model;
    else payload.model = upstreamModel;
    if (stream) {
      payload.stream_options = { ...(body.stream_options || {}), include_usage: true };
    } else {
      delete payload.stream_options;
    }

    const headers = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      ...(channel.headers || {}),
    };
    if (isAzure) headers['api-key'] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;

    return { url, headers, body: JSON.stringify(payload) };
  },

  normalizeResponse(json, { alias, created }) {
    if (!json || typeof json !== 'object') return json;
    json.model = alias;
    if (!json.created) json.created = Math.floor(created / 1000);
    if (json.usage) {
      const p = Number(json.usage.prompt_tokens) || 0;
      const c = Number(json.usage.completion_tokens) || 0;
      if (!json.usage.total_tokens) json.usage.total_tokens = p + c;
    }
    return json;
  },

  probe({ channel, apiKey, upstreamModel }) {
    if (channel.provider === 'azure') {
      if (!upstreamModel) {
        return { ok: false, status: 0, message: 'Azure 渠道需要先配置模型映射才能进行连通性测试' };
      }
      return {
        url: openaiAdapter.buildRequest({
          channel, upstreamModel, endpoint: 'chat', apiKey,
          body: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }, stream: false,
        }).url,
        init: {
          method: 'POST',
          headers: { ...openaiAdapter.buildRequest({
            channel, upstreamModel, endpoint: 'chat', apiKey,
            body: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }, stream: false,
          }).headers },
          body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
        },
      };
    }
    return {
      url: joinUrl(channel.base_url, '/models'),
      init: {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, ...(channel.headers || {}) },
      },
    };
  },
};
