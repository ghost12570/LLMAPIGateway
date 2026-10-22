import { decryptSecret } from '../util/crypto.js';

export function parseChannel(row) {
  if (!row) return null;
  let headers = {};
  try { headers = JSON.parse(row.headers || '{}'); } catch { /* ignore */ }
  return { ...row, headers };
}

export function getChannel(db, id) {
  return parseChannel(db.get('SELECT * FROM channels WHERE id = ?', id));
}

export function listChannelKeys(db, channelId, withSecret = false, masterSecret = null) {
  const rows = db.all('SELECT * FROM channel_keys WHERE channel_id = ? ORDER BY created_at ASC', channelId);
  return rows.map((row) => {
    const out = {
      id: row.id,
      channel_id: row.channel_id,
      hint: row.hint,
      status: row.status,
      weight: row.weight,
      last_used_at: row.last_used_at,
      created_at: row.created_at,
      success_count: row.success_count,
      error_count: row.error_count,
    };
    if (withSecret && masterSecret) {
      try { out.key = decryptSecret(masterSecret, row.encrypted_key); } catch { out.key = null; }
    }
    return out;
  });
}

export function listChannels(db, circuit) {
  const channels = db.all('SELECT * FROM channels ORDER BY priority ASC, created_at ASC');
  return channels.map((row) => {
    const channel = parseChannel(row);
    const keys = listChannelKeys(db, row.id);
    const models = db.all('SELECT model_alias, upstream_model, enabled FROM channel_models WHERE channel_id = ? ORDER BY model_alias', row.id);
    return {
      ...channel,
      key_count: keys.length,
      keys,
      models,
      circuit: circuit.snapshot(row.id),
    };
  });
}

export function getChannelModels(db, channelId) {
  return db.all('SELECT model_alias, upstream_model, enabled FROM channel_models WHERE channel_id = ?', channelId);
}

export function mappingsForAlias(db, alias, capabilities = []) {
  const rows = db.all(
    `SELECT cm.model_alias, cm.upstream_model, cm.enabled,
            c.id AS channel_id, c.name AS channel_name, c.provider, c.base_url, c.api_version,
            c.priority, c.weight, c.timeout_ms, c.first_byte_timeout_ms, c.concurrency_limit,
            c.status AS channel_status, c.headers
     FROM channel_models cm
     JOIN channels c ON c.id = cm.channel_id
     WHERE cm.model_alias = ? AND cm.enabled = 1 AND c.status = 'enabled'
     ORDER BY c.priority ASC, c.weight DESC`,
    alias,
  );
  return rows.map(parseChannel).filter((row) => {
    if (!capabilities.includes('embedding')) return true;
    return ['openai', 'azure', 'deepseek', 'dashscope', 'custom'].includes(row.provider);
  });
}

export function chooseChannelKey(db, channelId, masterSecret) {
  const rows = db.all("SELECT * FROM channel_keys WHERE channel_id = ? AND status = 'active' ORDER BY last_used_at ASC NULLS FIRST, created_at ASC", channelId);
  if (!rows.length) return null;
  const row = rows[0];
  let key;
  try {
    key = decryptSecret(masterSecret, row.encrypted_key);
  } catch {
    return null;
  }
  db.run('UPDATE channel_keys SET last_used_at = ? WHERE id = ?', Date.now(), row.id);
  return { id: row.id, key, hint: row.hint };
}

export function hasActiveKey(db, channelId) {
  return !!db.get("SELECT id FROM channel_keys WHERE channel_id = ? AND status = 'active' LIMIT 1", channelId);
}

export function providersMeta() {
  return [
    { id: 'openai', name: 'OpenAI', protocol: 'openai', default_base_url: 'https://api.openai.com/v1', supports: ['chat', 'completions', 'embeddings'] },
    { id: 'azure', name: 'Azure OpenAI', protocol: 'openai', default_base_url: 'https://{resource}.openai.azure.com', supports: ['chat', 'completions', 'embeddings'] },
    { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', default_base_url: 'https://api.anthropic.com', supports: ['chat'] },
    { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', default_base_url: 'https://api.deepseek.com/v1', supports: ['chat', 'completions', 'embeddings'] },
    { id: 'dashscope', name: '阿里云百炼 / 通义千问', protocol: 'openai', default_base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', supports: ['chat', 'completions', 'embeddings'] },
    { id: 'custom', name: '私有部署 / 自建', protocol: 'openai', default_base_url: 'http://127.0.0.1:8000/v1', supports: ['chat', 'completions', 'embeddings'] },
  ];
}
