import { logger } from '../util/logger.js';

export class AlertsService {
  constructor(db, settings) {
    this.db = db;
    this.settings = settings;
    this.queue = [];
    this.timer = setInterval(() => this.drain(), 2000);
    this.timer.unref?.();
  }

  raise({ type, level = 'warning', message, detail = {} }) {
    const id = `alt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const ts = Date.now();
    this.db.run('INSERT INTO alerts (id, ts, type, level, message, detail, delivered) VALUES (?, ?, ?, ?, ?, ?, 0)',
      id, ts, type, level, message, JSON.stringify(detail));
    this.queue.push({ id, type, level, message, detail, ts });
    logger.warn('alert', { type, level, message });
    this.drain();
    return id;
  }

  async drain() {
    if (!this.queue.length) return;
    const webhook = this.settings.get('alert.webhook_url', '');
    if (!webhook) return;
    const batch = this.queue.splice(0, 20);
    for (const alert of batch) {
      try {
        const type = this.settings.get('alert.webhook_type', 'feishu');
        const text = `[LLM Gateway][${alert.level.toUpperCase()}] ${alert.message}`;
        let body;
        if (type === 'feishu') body = JSON.stringify({ msg_type: 'text', content: { text } });
        else if (type === 'wecom') body = JSON.stringify({ msgtype: 'text', text: { content: text } });
        else body = JSON.stringify({ text, ...alert });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          this.db.run('UPDATE alerts SET delivered = 1, delivered_at = ? WHERE id = ?', Date.now(), alert.id);
        } else {
          logger.warn('alert webhook returned non-2xx', { status: res.status });
        }
      } catch (err) {
        logger.warn('alert webhook delivery failed', { error: err.message });
      }
    }
  }

  list(limit = 50) {
    return this.db.all('SELECT * FROM alerts ORDER BY ts DESC LIMIT ?', limit);
  }
}
