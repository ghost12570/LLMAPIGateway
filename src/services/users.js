export function listOrgs(db) {
  return db.all('SELECT * FROM orgs ORDER BY path ASC');
}

export function getOrg(db, id) {
  return db.get('SELECT * FROM orgs WHERE id = ?', id);
}

export function buildOrgTree(orgs) {
  const byId = new Map(orgs.map((o) => [o.id, { ...o, children: [] }]));
  const roots = [];
  for (const org of byId.values()) {
    if (org.parent_id && byId.has(org.parent_id)) byId.get(org.parent_id).children.push(org);
    else roots.push(org);
  }
  return roots;
}

export function descendantOrgIds(db, orgId) {
  const org = db.get('SELECT path FROM orgs WHERE id = ?', orgId);
  if (!org) return [];
  return db.all('SELECT id FROM orgs WHERE path = ? OR path LIKE ?', org.path, `${org.path}/%`).map((o) => o.id);
}

export function orgWithStats(db, org) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const spent = db.get(
    `SELECT COALESCE(SUM(l.cost_usd), 0) AS s FROM request_logs l
     JOIN orgs o ON o.id = l.org_id
     WHERE l.ts >= ? AND (o.path = ? OR o.path LIKE ?)`,
    monthStart, org.path, `${org.path}/%`,
  ).s;
  const users = db.get('SELECT COUNT(*) AS c FROM users WHERE org_id = ?', org.id).c;
  return { ...org, spent_usd: spent, user_count: users };
}

export function parseUser(row) {
  if (!row) return null;
  return { ...row };
}

export function getUser(db, id) {
  return parseUser(db.get('SELECT * FROM users WHERE id = ?', id));
}

export function getUserByEmail(db, email) {
  return parseUser(db.get('SELECT * FROM users WHERE lower(email) = lower(?)', email));
}

export function listUsers(db, { orgIds = null, role, status, q, page = 1, page_size = 50 } = {}) {
  const where = [];
  const params = [];
  if (Array.isArray(orgIds)) {
    if (!orgIds.length) where.push('1=0');
    else { where.push(`u.org_id IN (${orgIds.map(() => '?').join(',')})`); params.push(...orgIds); }
  }
  if (role) { where.push('u.role = ?'); params.push(role); }
  if (status) { where.push('u.status = ?'); params.push(status); }
  if (q) {
    where.push('(u.email LIKE ? OR u.name LIKE ? OR u.employee_no LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS c FROM users u ${clause}`, ...params).c;
  const size = Math.min(200, Math.max(1, Number(page_size) || 50));
  const p = Math.max(1, Number(page) || 1);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const items = db.all(
    `SELECT u.*, o.name AS org_name, o.path AS org_path,
       (SELECT COALESCE(SUM(l.cost_usd), 0) FROM request_logs l WHERE l.user_id = u.id AND l.ts >= ?) AS spent_usd,
       (SELECT COUNT(*) FROM api_keys k WHERE k.user_id = u.id AND k.status = 'active') AS key_count
     FROM users u LEFT JOIN orgs o ON o.id = u.org_id
     ${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    monthStart, ...params, size, (p - 1) * size,
  );
  return { items, total, page: p, page_size: size, pages: Math.max(1, Math.ceil(total / size)) };
}
