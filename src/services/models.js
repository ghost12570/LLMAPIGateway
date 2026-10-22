export function parseModel(row) {
  if (!row) return null;
  let capabilities = [];
  let fallback = [];
  try { capabilities = JSON.parse(row.capabilities || '[]'); } catch { /* ignore */ }
  try { fallback = JSON.parse(row.fallback_chain || '[]'); } catch { /* ignore */ }
  return { ...row, capabilities, fallback_chain: fallback, visible: !!row.visible };
}

export function getModel(db, alias) {
  return parseModel(db.get('SELECT * FROM models WHERE alias = ?', alias));
}

export function listModels(db, { includeHidden = false } = {}) {
  const rows = includeHidden
    ? db.all('SELECT * FROM models ORDER BY kind ASC, alias ASC')
    : db.all('SELECT * FROM models WHERE visible = 1 ORDER BY kind ASC, alias ASC');
  return rows.map(parseModel);
}

export function listModelsWithStats(db, includeHidden = true) {
  const rows = includeHidden
    ? db.all('SELECT * FROM models ORDER BY kind ASC, alias ASC')
    : db.all('SELECT * FROM models WHERE visible = 1 ORDER BY kind ASC, alias ASC');
  return rows.map((row) => {
    const model = parseModel(row);
    const mappings = db.all(
      `SELECT cm.channel_id, cm.upstream_model, cm.enabled, c.name AS channel_name, c.provider, c.status AS channel_status
       FROM channel_models cm JOIN channels c ON c.id = cm.channel_id WHERE cm.model_alias = ?`,
      row.alias,
    );
    return { ...model, mappings, channel_count: mappings.length, available: mappings.some((m) => m.enabled && m.channel_status === 'enabled') };
  });
}

export function modelAliases(db, visibleOnly = false) {
  return db.all(`SELECT alias FROM models ${visibleOnly ? 'WHERE visible = 1' : ''} ORDER BY alias`).map((r) => r.alias);
}

export function parseSmartRoutes(settings) {
  return settings.getJSON('smart_routes', {});
}
