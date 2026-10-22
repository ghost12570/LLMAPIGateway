export class ApiError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, signal, headers = {} } = {}) {
  const opts = {
    method,
    credentials: 'same-origin',
    signal,
    headers: { Accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, '网络连接失败，请检查网关服务是否可用', 'network_error', null);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const err = data?.error || {};
    if (res.status === 401 && !path.startsWith('/auth/login') && !path.startsWith('/auth/sso')) {
      window.dispatchEvent(new CustomEvent('gateway:unauthorized'));
    }
    throw new ApiError(res.status, err.message || `请求失败（HTTP ${res.status}）`, err.code || 'http_error', data);
  }
  return data;
}

export async function downloadCsv(path) {
  const res = await fetch(path, { credentials: 'same-origin' });
  if (!res.ok) {
    let message = `导出失败（HTTP ${res.status}）`;
    try { const data = await res.json(); message = data?.error?.message || message; } catch { /* ignore */ }
    throw new ApiError(res.status, message, 'download_failed', null);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  const filename = match ? match[1] : `export-${Date.now()}.csv`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function streamSse(path, body, { signal, onJson, onDone } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ignore */ }
    throw new ApiError(res.status, data?.error?.message || `请求失败（HTTP ${res.status}）`, data?.error?.code, data);
  }
  if (!res.body) throw new ApiError(0, '响应体为空', 'empty_body', null);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '');
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') {
        done = true;
        break;
      }
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.code || 502, json.error.message || '上游流式响应异常', json.error.code, json);
        onJson?.(json);
      } catch (err) {
        if (err instanceof ApiError) throw err;
      }
    }
  }
  onDone?.();
}
