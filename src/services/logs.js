import { logger } from '../util/logger.js';

const COLUMNS = [
  'id', 'ts', 'user_id', 'org_id', 'key_id', 'source', 'endpoint', 'model', 'upstream_model', 'channel_id',
  'provider', 'stream', 'status', 'http_status', 'latency_ms', 'ttft_ms', 'prompt_tokens', 'completion_tokens',
  'total_tokens', 'estimated', 'cost_usd', 'error_type', 'error_code', 'error_message', 'attempts', 'client_ip',
];

export class LogStore {
  constructor(db, { flushIntervalMs = 120, maxBatch = 1000 } = {}) {
    this.db = db;
    this.queue = [];
    this.flushIntervalMs = flushIntervalMs;
    this.maxBatch = maxBatch;
    this.timer = setInterval(() => this.flushSync(), this.flushIntervalMs);
    this.timer.unref?.();
    this.insert = db.prepare(`INSERT OR IGNORE INTO request_logs (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`);
  }

  record(entry) {
    const row = {};
    for (const col of COLUMNS) row[col] = entry[col] ?? null;
    if (row.stream !== null) row.stream = row.stream ? 1 : 0;
    if (row.estimated !== null) row.estimated = row.estimated ? 1 : 0;
    this.queue.push(COLUMNS.map((c) => row[c]));
    if (this.queue.length >= this.maxBatch) this.flushSync();
  }

  flushSync() {
    if (!this.queue.length) return;
    const batch = this.queue.splice(0, this.queue.length);
    try {
      this.db.transaction(() => {
        for (const row of batch) this.insert.run(...row);
      });
    } catch (err) {
      logger.error('failed to flush request logs', { error: err.message, rows: batch.length });
      if (this.queue.length < this.maxBatch * 5) this.queue.unshift(...batch);
    }
  }

  buildWhere(filters) {
    const where = [];
    const params = [];
    const add = (sql, value) => { where.push(sql); params.push(value); };
    if (filters.from) add('ts >= ?', Number(filters.from));
    if (filters.to) add('ts <= ?', Number(filters.to));
    if (filters.status) add('status = ?', filters.status);
    if (filters.http_status) add('http_status = ?', Number(filters.http_status));
    if (filters.model) add('model = ?', filters.model);
    if (filters.user_id) add('user_id = ?', filters.user_id);
    if (filters.key_id) add('key_id = ?', filters.key_id);
    if (filters.channel_id) add('channel_id = ?', filters.channel_id);
    if (filters.source) add('source = ?', filters.source);
    if (filters.request_id) add('id = ?', filters.request_id);
    if (filters.org_id) add('org_id = ?', filters.org_id);
    if (Array.isArray(filters.org_ids)) {
      if (!filters.org_ids.length) where.push('1=0');
      else { where.push(`org_id IN (${filters.org_ids.map(() => '?').join(',')})`); params.push(...filters.org_ids); }
    }
    if (filters.q) {
      where.push('(id LIKE ? OR model LIKE ? OR error_code LIKE ? OR user_id LIKE ? OR key_id LIKE ?)');
      const like = `%${filters.q}%`;
      params.push(like, like, like, like, like);
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  query(filters = {}) {
    this.flushSync();
    const page = Math.max(1, Number(filters.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(filters.page_size) || 50));
    const { clause, params } = this.buildWhere(filters);
    const total = this.db.get(`SELECT COUNT(*) AS c FROM request_logs ${clause}`, ...params).c;
    const items = this.db.all(
      `SELECT * FROM request_logs ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`,
      ...params, pageSize, (page - 1) * pageSize,
    );
    return { items, total, page, page_size: pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  get(id) {
    this.flushSync();
    return this.db.get('SELECT * FROM request_logs WHERE id = ?', id);
  }

  close() {
    clearInterval(this.timer);
    this.flushSync();
  }
}
