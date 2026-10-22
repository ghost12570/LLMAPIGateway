import { readJson } from '../util/http.js';
import { parseModel, listModelsWithStats, getModel } from '../services/models.js';
import {
  requireAdmin, SUPER_ONLY, badInput, notFound, requireString, requireNumber, optionalBoolean,
  ensureStringArray, auditAs,
} from './helpers.js';

const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

function modelInput(app, body, { create, alias: currentAlias } = {}) {
  const out = {};
  if (create || body.alias !== undefined) {
    const alias = requireString(body.alias, '模型别名', { max: 64 });
    if (!ALIAS_RE.test(alias)) throw badInput('模型别名只能包含字母、数字、点、下划线、冒号和短横线，且必须以字母或数字开头');
    out.alias = alias;
  }
  if (create || body.name !== undefined) out.name = requireString(body.name, '模型名称', { max: 200 });
  if (body.description !== undefined) out.description = String(body.description || '').slice(0, 2000);
  if (body.context_window !== undefined) out.context_window = requireNumber(body.context_window, '上下文窗口', { min: 0, max: 20000000, integer: true });
  if (body.max_output_tokens !== undefined) out.max_output_tokens = requireNumber(body.max_output_tokens, '最大输出 Tokens', { min: 0, max: 20000000, integer: true });
  if (body.input_price !== undefined) out.input_price = requireNumber(body.input_price, '输入价格', { min: 0, max: 1000 });
  if (body.output_price !== undefined) out.output_price = requireNumber(body.output_price, '输出价格', { min: 0, max: 1000 });
  if (body.capabilities !== undefined) out.capabilities = ensureStringArray(body.capabilities, 'capabilities', { max: 20 });
  if (body.visible !== undefined) out.visible = optionalBoolean(body.visible, 'visible');
  if (body.kind !== undefined) {
    if (!['model', 'router'].includes(body.kind)) throw badInput('kind must be model or router');
    out.kind = body.kind;
  }
  if (body.smart_group !== undefined) out.smart_group = body.smart_group ? String(body.smart_group).slice(0, 50) : null;
  if (body.fallback_chain !== undefined) {
    const chain = ensureStringArray(body.fallback_chain, 'fallback_chain', { max: 20 });
    const selfAlias = create ? out.alias : currentAlias;
    if (chain.includes(selfAlias)) throw badInput('fallback_chain cannot contain the model itself');
    for (const alias of chain) {
      if (!app.db.get('SELECT alias FROM models WHERE alias = ?', alias)) throw badInput(`Fallback model '${alias}' does not exist`);
    }
    out.fallback_chain = chain;
  }
  return out;
}

export function registerModelRoutes(router, app) {
  const { db, routing } = app;

  router.get('/api/admin/models', (req, res) => {
    requireAdmin(app, req, { roles: ['SUPER_ADMIN', 'AUDITOR'] });
    res.json({ items: listModelsWithStats(db, true) });
  });

  router.post('/api/admin/models', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const body = await readJson(req, 512 * 1024);
    const input = modelInput(app, body, { create: true });
    if (db.get('SELECT alias FROM models WHERE alias = ?', input.alias)) {
      throw badInput(`Model '${input.alias}' already exists`);
    }
    const ts = Date.now();
    db.run(
      `INSERT INTO models (alias, name, description, context_window, max_output_tokens, input_price, output_price,
        capabilities, visible, fallback_chain, kind, smart_group, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.alias, input.name, input.description || '', input.context_window ?? 0, input.max_output_tokens ?? 0,
      input.input_price ?? 0, input.output_price ?? 0, JSON.stringify(input.capabilities || ['chat']),
      input.visible === false ? 0 : 1, JSON.stringify(input.fallback_chain || []), input.kind || 'model',
      input.smart_group || null, ts, ts,
    );
    routing.invalidate();
    auditAs(app, session, 'model.created', { targetType: 'model', targetId: input.alias, detail: { name: input.name } });
    res.status(201).json({ model: parseModel(db.get('SELECT * FROM models WHERE alias = ?', input.alias)) });
  });

  router.put('/api/admin/models/:alias', async (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const alias = req.params.alias;
    const existing = getModel(db, alias);
    if (!existing) throw notFound('Model not found');
    const body = await readJson(req, 512 * 1024);
    if (body.alias !== undefined && body.alias !== alias) throw badInput('模型别名创建后不可修改');
    const input = modelInput(app, body, { create: false, alias });
    const fields = [];
    const params = [];
    for (const [key, value] of Object.entries(input)) {
      if (key === 'alias') continue;
      fields.push(`${key} = ?`);
      if (key === 'capabilities' || key === 'fallback_chain') params.push(JSON.stringify(value));
      else if (key === 'visible') params.push(value ? 1 : 0);
      else params.push(value);
    }
    if (fields.length) {
      params.push(Date.now(), alias);
      db.run(`UPDATE models SET ${fields.join(', ')}, updated_at = ? WHERE alias = ?`, ...params);
    }
    routing.invalidate();
    auditAs(app, session, 'model.updated', { targetType: 'model', targetId: alias, detail: { fields: Object.keys(input) } });
    res.json({ model: getModel(db, alias) });
  });

  router.delete('/api/admin/models/:alias', (req, res) => {
    const session = requireAdmin(app, req, { roles: SUPER_ONLY, write: true });
    const alias = req.params.alias;
    const existing = getModel(db, alias);
    if (!existing) throw notFound('Model not found');
    const mapped = db.get('SELECT COUNT(*) AS c FROM channel_models WHERE model_alias = ?', alias).c;
    if (mapped) throw badInput(`该模型仍被 ${mapped} 个渠道映射引用，请先在渠道中移除映射`);
    const routed = db.all('SELECT alias FROM models WHERE fallback_chain LIKE ?', `%${alias}%`)
      .filter((m) => {
        try { return JSON.parse(m.fallback_chain || '[]').includes(alias); } catch { return false; }
      });
    if (routed.length) throw badInput(`该模型仍被 ${routed.length} 个回退链引用`);
    db.run('DELETE FROM models WHERE alias = ?', alias);
    routing.invalidate();
    auditAs(app, session, 'model.deleted', { targetType: 'model', targetId: alias });
    res.json({ ok: true });
  });
}
