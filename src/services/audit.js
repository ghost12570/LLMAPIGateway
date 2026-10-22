import { randomId } from '../util/crypto.js';

export function writeAudit(db, { actor, action, targetType, targetId, detail, ip }) {
  db.run(
    'INSERT INTO audit_logs (id, ts, actor_id, actor_email, action, target_type, target_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    randomId('aud_'), Date.now(), actor?.id || null, actor?.email || null, action,
    targetType || null, targetId || null, detail ? JSON.stringify(detail) : null, ip || null,
  );
}

export function listAudit(db, { page = 1, page_size = 50, action, q } = {}) {
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (q) {
    where.push('(actor_email LIKE ? OR target_id LIKE ? OR action LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS c FROM audit_logs ${clause}`, ...params).c;
  const size = Math.min(200, Math.max(1, Number(page_size) || 50));
  const p = Math.max(1, Number(page) || 1);
  const items = db.all(`SELECT * FROM audit_logs ${clause} ORDER BY ts DESC LIMIT ? OFFSET ?`, ...params, size, (p - 1) * size);
  return { items, total, page: p, page_size: size, pages: Math.max(1, Math.ceil(total / size)) };
}
