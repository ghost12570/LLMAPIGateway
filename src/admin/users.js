import { readJson } from '../util/http.js';
import { hashPassword, randomId, randomString } from '../util/crypto.js';
import { listUsers, getUser, getOrg, listOrgs, buildOrgTree, orgWithStats, descendantOrgIds } from '../services/users.js';
import {
  requireAdmin, SUPER_ONLY, WRITE_ROLES, orgScope, inScope, badInput, notFound, conflict,
  requireString, requireNumber, auditAs,
} from './helpers.js';

const ROLES = ['SUPER_ADMIN', 'ORG_ADMIN', 'APP_USER', 'AUDITOR'];

function parseQuota(value, name) {
  return requireNumber(value, name, { min: 0, max: 100000000 });
}

function assertLastSuperNotRemoved(app, userId, nextRole, nextStatus) {
  const user = app.db.get('SELECT * FROM users WHERE id = ?', userId);
  if (!user || user.role !== 'SUPER_ADMIN') return;
  if (nextRole === 'SUPER_ADMIN' && nextStatus !== 'frozen') return;
  const activeSupers = app.db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'SUPER_ADMIN' AND status = 'active'").c;
  if (activeSupers <= 1) throw conflict('Cannot demote or freeze the last active super administrator');
}

export function registerUserRoutes(router, app) {
  const { db } = app;

  // ---------- Organizations ----------
  router.get('/api/admin/orgs', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    let orgs = listOrgs(db);
    if (scope) orgs = orgs.filter((o) => scope.includes(o.id));
    const items = orgs.map((o) => orgWithStats(db, o));
    res.json({ items, tree: buildOrgTree(items) });
  });

  router.post('/api/admin/orgs', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const body = await readJson(req, 256 * 1024);
    const name = requireString(body.name, '组织名称', { max: 100 });
    const quota = parseQuota(body.monthly_quota_usd ?? 0, '部门月度配额');
    const parentId = body.parent_id || null;
    if (parentId && !getOrg(db, parentId)) throw badInput('Parent organization not found');
    const id = randomId('org_');
    const path = parentId ? `${getOrg(db, parentId).path}/${id}` : `/${id}`;
    const ts = Date.now();
    db.run(
      'INSERT INTO orgs (id, name, parent_id, path, monthly_quota_usd, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, parentId, path, quota, 'active', ts, ts,
    );
    app.quota.invalidateOrgs();
    app.keyAuth.invalidateAll();
    auditAs(app, session, 'org.created', { targetType: 'org', targetId: id, detail: { name, parent_id: parentId, quota } });
    res.status(201).json({ org: orgWithStats(db, getOrg(db, id)) });
  });

  router.put('/api/admin/orgs/:id', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const org = getOrg(db, req.params.id);
    if (!org) throw notFound('Organization not found');
    const body = await readJson(req, 256 * 1024);
    const name = body.name !== undefined ? requireString(body.name, '组织名称', { max: 100 }) : org.name;
    const quota = body.monthly_quota_usd !== undefined ? parseQuota(body.monthly_quota_usd, '部门月度配额') : org.monthly_quota_usd;
    const status = body.status !== undefined ? String(body.status) : org.status;
    if (!['active', 'disabled'].includes(status)) throw badInput('status must be active or disabled');
    let parentId = body.parent_id !== undefined ? (body.parent_id || null) : org.parent_id;
    if (parentId === org.id) throw badInput('An organization cannot be its own parent');
    if (parentId) {
      const parent = getOrg(db, parentId);
      if (!parent) throw badInput('Parent organization not found');
      if (parent.path === org.path || parent.path.startsWith(`${org.path}/`)) {
        throw badInput('Cannot move an organization under one of its own descendants');
      }
    }
    const newPath = parentId ? `${getOrg(db, parentId).path}/${org.id}` : `/${org.id}`;
    const ts = Date.now();
    db.transaction(() => {
      db.run('UPDATE orgs SET name = ?, parent_id = ?, path = ?, monthly_quota_usd = ?, status = ?, updated_at = ? WHERE id = ?',
        name, parentId, newPath, quota, status, ts, org.id);
      if (newPath !== org.path) {
        const oldPrefix = `${org.path}/`;
        const newPrefix = `${newPath}/`;
        const descendants = db.all('SELECT id, path FROM orgs WHERE path LIKE ?', `${oldPrefix}%`);
        for (const d of descendants) {
          db.run('UPDATE orgs SET path = ?, updated_at = ? WHERE id = ?', newPrefix + d.path.slice(oldPrefix.length), ts, d.id);
        }
      }
      if (status === 'disabled') {
        db.run("UPDATE api_keys SET status = 'disabled', updated_at = ? WHERE org_id = ? AND status = 'active'", ts, org.id);
      }
    });
    app.quota.invalidateOrgs();
    app.keyAuth.invalidateAll();
    auditAs(app, session, 'org.updated', { targetType: 'org', targetId: org.id, detail: { name, quota, status, parent_id: parentId } });
    res.json({ org: orgWithStats(db, getOrg(db, org.id)) });
  });

  router.delete('/api/admin/orgs/:id', (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const org = getOrg(db, req.params.id);
    if (!org) throw notFound('Organization not found');
    const children = db.get('SELECT COUNT(*) AS c FROM orgs WHERE parent_id = ?', org.id).c;
    const users = db.get('SELECT COUNT(*) AS c FROM users WHERE org_id = ?', org.id).c;
    if (children || users) throw conflict('Cannot delete an organization that still has child organizations or users');
    db.run('DELETE FROM orgs WHERE id = ?', org.id);
    app.quota.invalidateOrgs();
    auditAs(app, session, 'org.deleted', { targetType: 'org', targetId: org.id, detail: { name: org.name } });
    res.json({ ok: true });
  });

  // ---------- Users ----------
  router.get('/api/admin/users', (req, res) => {
    const session = requireAdmin(app, req);
    const scope = orgScope(app, session);
    const url = new URL(req.url, 'http://localhost');
    const result = listUsers(db, {
      orgIds: scope,
      role: url.searchParams.get('role') || undefined,
      status: url.searchParams.get('status') || undefined,
      q: url.searchParams.get('q') || undefined,
      page: url.searchParams.get('page'),
      page_size: url.searchParams.get('page_size'),
    });
    res.json(result);
  });

  router.post('/api/admin/users', async (req, res) => {
    const session = requireAdmin(app, req, { roles: WRITE_ROLES, write: true });
    const body = await readJson(req, 512 * 1024);
    const isOrgAdmin = session.user.role === 'ORG_ADMIN';
    const email = requireString(body.email, '邮箱', { max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badInput('邮箱格式不正确');
    const name = requireString(body.name, '姓名', { max: 100 });
    const role = body.role || 'APP_USER';
    if (!ROLES.includes(role)) throw badInput('Invalid role');
    if (isOrgAdmin && !['APP_USER', 'AUDITOR'].includes(role)) throw badInput('部门管理员只能创建普通用户或审计员');
    const orgId = body.org_id || session.user.org_id;
    const org = getOrg(db, orgId);
    if (!org) throw badInput('Organization not found');
    if (isOrgAdmin && !inScope(app, session, orgId)) throw badInput('Cannot create users outside your organization');
    if (db.get('SELECT id FROM users WHERE lower(email) = ?', email)) throw conflict('A user with this email already exists');
    const quota = parseQuota(body.monthly_quota_usd ?? 0, '个人月度配额');
    const providedPassword = body.password ? String(body.password) : null;
    if (providedPassword && providedPassword.length < 8) throw badInput('密码至少需要 8 位');
    const password = providedPassword || randomString(16);
    const passwordHash = await hashPassword(password);
    const id = randomId('usr_');
    const ts = Date.now();
    db.run(
      `INSERT INTO users (id, email, name, employee_no, role, org_id, status, password_hash, auth_source,
        monthly_quota_usd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, 'local', ?, ?, ?)`,
      id, email, name, body.employee_no ? String(body.employee_no).slice(0, 50) : null, role, orgId, passwordHash, quota, ts, ts,
    );
    app.keyAuth.invalidateAll();
    auditAs(app, session, 'user.created', { targetType: 'user', targetId: id, detail: { email, role, org_id: orgId, quota } });
    const user = getUser(db, id);
    delete user.password_hash;
    res.status(201).json({ user, initial_password: password });
  });

  router.post('/api/admin/users/import', async (req, res) => {
    const session = requireAdmin(app, req, { roles: WRITE_ROLES, write: true });
    const body = await readJson(req, 1024 * 1024);
    const rows = Array.isArray(body.users) ? body.users : null;
    if (!rows || !rows.length) throw badInput('users must be a non-empty array');
    if (rows.length > 200) throw badInput('单次最多导入 200 个用户');
    const isOrgAdmin = session.user.role === 'ORG_ADMIN';
    const orgs = listOrgs(db);
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const orgByName = new Map(orgs.map((o) => [o.name.toLowerCase(), o]));
    const allowedOrgIds = isOrgAdmin ? new Set(orgScope(app, session)) : null;
    const errors = [];
    const prepared = [];
    const seenEmails = new Set();
    rows.forEach((row, index) => {
      try {
        const name = requireString(row.name, '姓名', { max: 100 });
        const email = requireString(row.email, '邮箱', { max: 200 }).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('邮箱格式不正确');
        const role = row.role || 'APP_USER';
        if (!ROLES.includes(role)) throw new Error('角色不合法');
        if (isOrgAdmin && !['APP_USER', 'AUDITOR'].includes(role)) throw new Error('部门管理员只能导入普通用户或审计员');
        let org = row.org_id ? orgById.get(row.org_id) : null;
        if (!org && row.org_name) org = orgByName.get(String(row.org_name).trim().toLowerCase());
        if (!org && !row.org_id && !row.org_name) org = orgById.get(session.user.org_id);
        if (!org) throw new Error('组织不存在');
        if (allowedOrgIds && !allowedOrgIds.has(org.id)) throw new Error('组织不在管理范围内');
        const quota = Number(row.monthly_quota_usd ?? 0);
        if (!Number.isFinite(quota) || quota < 0) throw new Error('月度配额不合法');
        const password = row.password ? String(row.password) : randomString(16);
        if (password.length < 8) throw new Error('密码至少需要 8 位');
        if (seenEmails.has(email)) throw new Error('本次导入中邮箱重复');
        seenEmails.add(email);
        if (db.get('SELECT id FROM users WHERE lower(email) = ?', email)) {
          prepared.push({ skip: true, email });
          return;
        }
        prepared.push({ name, email, role, orgId: org.id, quota, password, skip: false });
      } catch (err) {
        errors.push({ row: index + 1, email: row.email || '', message: err.message });
      }
    });
    const toCreate = prepared.filter((p) => !p.skip);
    await Promise.all(toCreate.map(async (p) => { p.hash = await hashPassword(p.password); }));
    const ts = Date.now();
    let created = 0;
    db.transaction(() => {
      for (const p of toCreate) {
        const id = randomId('usr_');
        db.run(
          `INSERT INTO users (id, email, name, employee_no, role, org_id, status, password_hash, auth_source,
            monthly_quota_usd, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 'active', ?, 'local', ?, ?, ?)`,
          id, p.email, p.name, p.role, p.orgId, p.hash, p.quota, ts, ts,
        );
        p.id = id;
        created++;
      }
    });
    const credentials = toCreate.map((p) => ({ name: p.name, email: p.email, password: p.password }));
    const skipped = prepared.filter((p) => p.skip).length + errors.length;
    app.keyAuth.invalidateAll();
    auditAs(app, session, 'users.imported', { targetType: 'user', targetId: 'bulk', detail: { created, skipped, errors: errors.length } });
    res.status(200).json({ created, skipped, errors, credentials });
  });

  router.put('/api/admin/users/:id', async (req, res) => {
    const session = requireAdmin(app, req, { roles: WRITE_ROLES, write: true });
    const user = getUser(db, req.params.id);
    if (!user) throw notFound('User not found');
    const isOrgAdmin = session.user.role === 'ORG_ADMIN';
    if (isOrgAdmin) {
      if (!inScope(app, session, user.org_id)) throw notFound('User not found');
      if (user.role === 'SUPER_ADMIN') throw badInput('Cannot modify a super administrator');
    }
    const body = await readJson(req, 512 * 1024);
    const role = body.role !== undefined ? body.role : user.role;
    if (!ROLES.includes(role)) throw badInput('Invalid role');
    if (isOrgAdmin && role === 'SUPER_ADMIN') throw badInput('部门管理员不能授予超级管理员角色');
    const status = body.status !== undefined ? String(body.status) : user.status;
    if (!['active', 'frozen'].includes(status)) throw badInput('status must be active or frozen');
    if (user.id === session.user.id && status === 'frozen') throw badInput('You cannot freeze your own account');
    assertLastSuperNotRemoved(app, user.id, role, status);

    const orgId = body.org_id !== undefined ? body.org_id : user.org_id;
    if (!getOrg(db, orgId)) throw badInput('Organization not found');
    if (isOrgAdmin && !inScope(app, session, orgId)) throw badInput('Cannot move users outside your organization');
    const name = body.name !== undefined ? requireString(body.name, '姓名', { max: 100 }) : user.name;
    const email = body.email !== undefined ? requireString(body.email, '邮箱', { max: 200 }).toLowerCase() : user.email;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badInput('邮箱格式不正确');
    const dup = db.get('SELECT id FROM users WHERE lower(email) = ? AND id != ?', email, user.id);
    if (dup) throw conflict('A user with this email already exists');
    const quota = body.monthly_quota_usd !== undefined ? parseQuota(body.monthly_quota_usd, '个人月度配额') : user.monthly_quota_usd;
    const ts = Date.now();

    db.transaction(() => {
      db.run(
        `UPDATE users SET email = ?, name = ?, employee_no = ?, role = ?, org_id = ?, status = ?, monthly_quota_usd = ?, updated_at = ?
         WHERE id = ?`,
        email, name, body.employee_no !== undefined ? String(body.employee_no || '').slice(0, 50) || null : user.employee_no,
        role, orgId, status, quota, ts, user.id,
      );
      if (orgId !== user.org_id) db.run('UPDATE api_keys SET org_id = ?, updated_at = ? WHERE user_id = ?', orgId, ts, user.id);
      if (status === 'frozen') {
        db.run("UPDATE api_keys SET status = 'revoked', updated_at = ? WHERE user_id = ? AND status != 'revoked'", ts, user.id);
      }
    });
    app.keyAuth.invalidateUser(user.id);
    auditAs(app, session, 'user.updated', { targetType: 'user', targetId: user.id, detail: { email, role, org_id: orgId, status, quota } });
    const updated = getUser(db, user.id);
    delete updated.password_hash;
    res.json({ user: updated });
  });

  router.put('/api/admin/users/:id/password', async (req, res) => {
    const session = requireAdmin(app, req, { roles: WRITE_ROLES, write: true });
    const user = getUser(db, req.params.id);
    if (!user) throw notFound('User not found');
    if (!inScope(app, session, user.org_id)) throw notFound('User not found');
    if (user.role === 'SUPER_ADMIN' && session.user.role !== 'SUPER_ADMIN') throw badInput('Cannot reset a super administrator password');
    const body = await readJson(req, 64 * 1024);
    const password = String(body.password || '');
    if (password.length < 8) throw badInput('密码至少需要 8 位');
    const hash = await hashPassword(password);
    db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', hash, Date.now(), user.id);
    auditAs(app, session, 'user.password_reset', { targetType: 'user', targetId: user.id });
    res.json({ ok: true });
  });

  router.get('/api/admin/users/:id/keys', (req, res) => {
    const session = requireAdmin(app, req);
    const user = getUser(db, req.params.id);
    if (!user) throw notFound('User not found');
    if (!inScope(app, session, user.org_id)) throw notFound('User not found');
    const keys = db.all('SELECT id, name, masked, status, monthly_limit_usd, total_limit_usd, expires_at, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', user.id);
    res.json({ items: keys });
  });

  router.get('/api/admin/org-scope', (req, res) => {
    const session = requireAdmin(app, req);
    const ids = orgScope(app, session) || listOrgs(db).map((o) => o.id);
    res.json({ ok: true, count: ids.length });
  });
}
