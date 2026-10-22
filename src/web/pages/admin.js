import { api, downloadCsv } from '../api.js';
import * as ui from '../ui.js';

const h = ui.escapeHtml;
const CAPABILITIES = ['chat', 'vision', 'tools', 'reasoning', 'coding', 'embedding'];
const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', proto: 'OpenAI 兼容', base: 'https://api.openai.com/v1' },
  { id: 'azure', name: 'Azure OpenAI', proto: 'OpenAI 兼容', base: 'https://your-resource.openai.azure.com' },
  { id: 'anthropic', name: 'Anthropic Claude', proto: 'Claude Messages API', base: 'https://api.anthropic.com' },
  { id: 'deepseek', name: 'DeepSeek', proto: 'OpenAI 兼容', base: 'https://api.deepseek.com/v1' },
  { id: 'dashscope', name: '阿里云百炼', proto: 'OpenAI 兼容', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'custom', name: '私有部署 / 自建', proto: 'OpenAI 兼容', base: 'http://127.0.0.1:8000/v1' },
];
const AUDIT_ACTIONS = {
  'settings.updated': '更新系统设置',
  'channel.created': '创建渠道',
  'channel.updated': '更新渠道',
  'channel.deleted': '删除渠道',
  'channel.tested': '测试渠道',
  'channel.toggled': '启停渠道',
  'channel.circuit_reset': '重置熔断',
  'channel.keys.added': '添加上游 Key',
  'channel.keys.deleted': '删除上游 Key',
  'model.created': '创建模型',
  'model.updated': '更新模型',
  'model.deleted': '删除模型',
  'user.created': '创建用户',
  'user.updated': '更新用户',
  'user.password_reset': '重置用户密码',
  'users.imported': '批量导入用户',
  'org.created': '创建组织',
  'org.updated': '更新组织',
  'org.deleted': '删除组织',
  'key.issued_by_admin': '管理员签发 Key',
  'key.updated': '更新 Key',
  'key.revoked_by_admin': '管理员吊销 Key',
  'key.created': '用户创建 Key',
  'key.revoked': '用户吊销 Key',
  'auth.login.success': '登录成功',
  'auth.login.failed': '登录失败',
  'auth.logout': '退出登录',
  'auth.sso.success': 'SSO 登录',
  'auth.password.changed': '修改密码',
  'auth.api_key.failed': 'API Key 鉴权失败',
};

function pageHead(ctx, title, sub, actions = '') {
  return `<div class="page-head">
    <div><h1 class="page-title">${h(title)}</h1><p class="page-sub">${h(sub)}</p></div>
    <div class="page-actions">${actions}</div>
  </div>`;
}

function notice(message, tone = '') {
  return `<div class="notice ${tone}">${ui.icon(tone === 'danger' ? 'alert' : 'info', 16)}<div>${message}</div></div>`;
}

function delta(curr, prev, suffix = '') {
  const c = Number(curr) || 0;
  const p = Number(prev) || 0;
  if (!p) return `<span class="delta flat">—${suffix ? ` ${h(suffix)}` : ''}</span>`;
  const diff = ((c - p) / p) * 100;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const sign = diff > 0 ? '+' : '';
  return `<span class="delta ${cls}">${sign}${diff.toFixed(1)}% ${suffix ? h(suffix) : ''}</span>`;
}

function costHtml(value) {
  return `<div class="cost-split"><span class="usd">${ui.usd(value)}</span><span class="cny">≈ ${ui.cny(value, 7.2)}</span></div>`;
}

function statCard({ label, value, unit = '', iconName, tone, meta, spark }) {
  return `<div class="card stat">
    <div class="stat-top">
      <div><div class="stat-label">${h(label)}</div><div class="stat-value">${value}${unit ? `<span class="unit">${h(unit)}</span>` : ''}</div></div>
      <div class="stat-icon ${tone}">${ui.icon(iconName, 17)}</div>
    </div>
    <div class="stat-meta"><div>${meta}</div>${spark || ''}</div>
  </div>`;
}

function tableFoot(pagination, total, page, pages) {
  const p = ui.paginationHtml({ page, pages, total });
  return `<div class="table-foot"><div>${p.meta}</div><div class="pagination">${p.buttons}</div></div>`;
}

function modelOptions(catalog, selected = '') {
  return catalog.map((m) => `<option value="${h(m.alias)}" ${m.alias === selected ? 'selected' : ''}>${h(m.alias)}${m.kind === 'router' ? '（路由）' : ''} — ${h(m.name)}</option>`).join('');
}

function orgOptions(orgs, selected = '', { exclude = null } = {}) {
  return orgs.filter((o) => !exclude || (o.id !== exclude && !o.path.startsWith(`${orgs.find((x) => x.id === exclude)?.path || '__'}/`)))
    .map((o) => {
      const depth = Math.max(0, o.path.split('/').length - 2);
      return `<option value="${h(o.id)}" ${o.id === selected ? 'selected' : ''}>${'　'.repeat(depth)}${h(o.name)}</option>`;
    }).join('');
}

function channelHealth(c) {
  if (c.status !== 'enabled') return { label: '已停用', tone: 'gray', dot: 'gray' };
  const circuit = ui.circuitMeta(c.circuit?.state);
  if (circuit.tone === 'red') return { label: '熔断中', tone: 'red', dot: 'red' };
  if (circuit.tone === 'amber') return { label: '半开探测', tone: 'amber', dot: 'amber' };
  if (c.health?.status === 'healthy') return { label: '健康', tone: 'green', dot: 'green' };
  if (c.health?.status === 'error') return { label: '探测异常', tone: 'red', dot: 'red' };
  return { label: '待探测', tone: 'gray', dot: 'gray' };
}

function dateInputValue(ts) {
  const d = ts ? new Date(ts) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDateMs(value, endOfDay = false) {
  if (!value) return null;
  const d = new Date(`${value}T${endOfDay ? '23:59:59' : '00:00:00'}`);
  return d.getTime();
}

function statusPill(status, httpStatus) {
  return ui.statusBadge(status, httpStatus);
}

function sourceBadge(source) {
  return source === 'playground' ? ui.badge('调试台', 'cyan') : ui.badge('API', 'gray');
}

function providerPill(provider) {
  return ui.badge(ui.providerName(provider), ui.providerTone(provider));
}

function loadError(el, err) {
  el.innerHTML = `<div class="notice danger">${ui.icon('alert', 16)}<div><b>加载失败</b><div class="mt-8">${h(err.message || '未知错误')}</div></div></div>`;
}

/* =====================================================================
 *  OVERVIEW
 * ===================================================================== */
async function overview(el, ctx) {
  let data = null;
  let metric = 'requests';
  let timer = null;

  const renderChart = () => {
    const target = el.querySelector('#traffic-chart');
    if (!target || !data) return;
    const conf = {
      requests: { color: '#8b5cf6', label: '请求数', format: ui.compact, value: 'requests' },
      tokens: { color: '#22d3ee', label: 'Token 数', format: ui.compact, value: 'tokens' },
      cost: { color: '#34d399', label: '成本', format: (v) => ui.usd(v), value: 'cost' },
    }[metric];
    ui.areaChart(target, {
      points: data.series,
      value: conf.value,
      color: conf.color,
      label: conf.label,
      format: conf.format,
      xFormat: ui.timeOfDay,
    });
  };

  const render = () => {
    const t = data.today;
    const m = data.month;
    const live = data.live || {};
    const seriesReq = data.series.map((p) => p.requests);
    const seriesToken = data.series.map((p) => p.tokens);
    const seriesCost = data.series.map((p) => p.cost);
    const successPct = Number(t.success_rate || 0) * 100;
    const channels = data.channels || [];
    const healthBuckets = { healthy: 0, degraded: 0, open: 0, disabled: 0 };
    for (const c of channels) {
      if (c.status !== 'enabled') healthBuckets.disabled++;
      else if (c.circuit?.state === 'open' || c.circuit?.state === 'half_open') healthBuckets.open++;
      else if (c.health?.status === 'healthy') healthBuckets.healthy++;
      else healthBuckets.degraded++;
    }
    const donutItems = [
      { label: '渠道健康', value: healthBuckets.healthy, color: '#34d399' },
      { label: '待探测 / 异常', value: healthBuckets.degraded, color: '#fbbf24' },
      { label: '熔断中', value: healthBuckets.open, color: '#f87171' },
      { label: '已停用', value: healthBuckets.disabled, color: '#4b5670' },
    ];
    const maxCost = Math.max(0.000001, ...(data.top_models || []).map((x) => Number(x.cost) || 0));
    el.innerHTML = `
      ${pageHead(ctx, '运营概览', `实时掌握平台流量、渠道健康与成本态势 · ${data.role === 'ORG_ADMIN' ? '当前展示本组织数据' : '全平台数据'}`, `
        <button class="btn" id="refresh-overview">${ui.icon('refresh', 15)} 刷新</button>
        ${ctx.state.permissions.manage_platform ? `<button class="btn primary" id="go-channels">${ui.icon('server', 15)} 管理渠道</button>` : ''}
      `)}
      <div class="grid grid-4">
        ${statCard({ label: '今日请求数', value: ui.num(t.requests), iconName: 'activity', tone: 'violet', meta: `实时 ${Number(live.qps || 0).toFixed(1)} QPS · 并发 ${live.inflight || 0}`, spark: ui.sparkline(seriesReq, '#8b5cf6') })}
        ${statCard({ label: '今日消费', value: ui.usd(t.cost_usd), iconName: 'wallet', tone: 'green', meta: `本月 ${ui.usd(m.cost_usd)} · ${delta(t.cost_usd, t.yesterday_cost_usd, '较昨日')}`, spark: ui.sparkline(seriesCost, '#34d399') })}
        ${statCard({ label: 'Token 消耗', value: ui.compact(t.total_tokens), iconName: 'zap', tone: 'cyan', meta: `输入 ${ui.compact(t.prompt_tokens)} · 输出 ${ui.compact(t.completion_tokens)}`, spark: ui.sparkline(seriesToken, '#22d3ee') })}
        ${statCard({ label: '请求成功率', value: `${successPct.toFixed(1)}<span class="unit">%</span>`, iconName: 'check-circle', tone: successPct >= 99 ? 'green' : successPct >= 95 ? 'amber' : 'red', meta: `失败 ${ui.num(t.errors)} 次 · P95 ${ui.duration(live.p95_latency_ms)}`, spark: ui.sparkline(data.series.map((p) => p.requests - p.errors), '#34d399') })}
      </div>
      <div class="grid grid-2-1 mt-16">
        <div class="card">
          <div class="card-head">
            <div><div class="card-title">${ui.icon('activity', 16)} 24 小时流量趋势</div><div class="card-desc">按 5 分钟聚合 · 每 20 秒自动刷新</div></div>
            <div class="card-actions">
              <div class="seg" id="metric-seg">
                <button data-metric="requests" class="${metric === 'requests' ? 'active' : ''}">请求数</button>
                <button data-metric="tokens" class="${metric === 'tokens' ? 'active' : ''}">Token</button>
                <button data-metric="cost" class="${metric === 'cost' ? 'active' : ''}">成本</button>
              </div>
            </div>
          </div>
          <div class="card-body" id="traffic-chart"></div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><div class="card-title">${ui.icon('server', 16)} 渠道健康</div><div class="card-desc">${channels.length} 个渠道 · 可用率 ${data.channel_availability}%</div></div>${ui.badge(data.channel_availability >= 99 ? '运行良好' : '需关注', data.channel_availability >= 99 ? 'green' : 'amber')}</div>
            <div class="card-body">
              ${ui.donut(donutItems, { centerLabel: '渠道可用率', centerValue: `${data.channel_availability}%`, size: 136, format: ui.num })}
              <div class="divider"></div>
              <div class="health-list">
                ${channels.slice(0, 5).map((c) => {
                  const hs = channelHealth(c);
                  return `<div class="health-row"><span class="dot ${hs.dot}"></span><span class="name">${h(c.name)}</span><span class="badge ${hs.tone}">${hs.label}</span><span class="meta">${c.health?.latency_ms ? `${c.health.latency_ms}ms` : '—'}</span></div>`;
                }).join('') || ui.emptyState('暂无渠道', '', 'server')}
              </div>
            </div>
          </div>
          ${data.alerts?.length ? `<div class="card">
            <div class="card-head"><div class="card-title">${ui.icon('alert', 16)} 告警</div><a class="btn ghost sm" href="/admin#/logs">查看</a></div>
            <div class="card-body" style="padding-top:10px">
              ${data.alerts.slice(0, 3).map((a) => `<div class="alert-row"><div class="alert-level ${a.level === 'critical' ? 'critical' : a.level === 'info' ? 'info' : ''}"></div><div class="alert-main"><div class="alert-msg">${h(a.message)}</div><div class="alert-meta">${ui.timeAgo(a.ts)}</div></div></div>`).join('')}
            </div>
          </div>` : ''}
        </div>
      </div>
      <div class="grid grid-2-1 mt-16">
        <div class="card">
          <div class="card-head"><div><div class="card-title">${ui.icon('layers', 16)} 模型消费排行</div><div class="card-desc">今日成本贡献 Top ${data.top_models?.length || 0}</div></div><a class="btn ghost sm" href="/admin#/models">模型目录</a></div>
          <div class="card-body">
            ${(data.top_models || []).length ? `<div class="bar-list">
              ${data.top_models.map((m) => `<div class="bar-item">
                <div class="bar-top"><div class="bar-label"><span class="mono" style="font-size:11.5px">${h(m.model)}</span>${ui.badge(`${ui.num(m.requests)} 次`, 'gray')}</div><span class="muted mono" style="font-size:11px">${ui.usd(m.cost)}</span></div>
                <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (Number(m.cost) / maxCost) * 100)}%"></div></div>
              </div>`).join('')}
            </div>` : ui.emptyState('今日暂无模型调用', '', 'layers')}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="card-title">${ui.icon('alert', 16)} 最近错误</div><div class="card-desc">今日失败请求</div></div><a class="btn ghost sm" href="/admin#/logs">全部日志</a></div>
          <div class="card-body" style="padding-top:10px">
            ${(data.recent_errors || []).length ? `<div class="error-list">
              ${data.recent_errors.map((e) => `<div class="error-row"><div class="error-icon">${ui.icon('alert', 13)}</div><div class="error-main"><div class="error-msg">${h(e.error_message || e.error_code || '请求失败')}</div><div class="error-meta"><span class="mono">${h(e.model)}</span><span>HTTP ${e.http_status}</span><span>${ui.timeAgo(e.ts)}</span></div></div></div>`).join('')}
            </div>` : ui.emptyState('今日暂无错误请求', '', 'check-circle')}
          </div>
        </div>
      </div>
      <div class="card mt-16">
        <div class="card-head"><div><div class="card-title">${ui.icon('list', 16)} 最近请求</div><div class="card-desc">全链路元数据 · 默认不存储 Prompt 内容</div></div><a class="btn ghost sm" href="/admin#/logs">查看全部 ${ui.icon('chevron-right', 13)}</a></div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>时间</th><th>模型</th><th>状态</th><th class="num">延迟</th><th class="num">Tokens</th><th class="num">成本</th><th>渠道</th></tr></thead>
            <tbody>
              ${(data.recent_requests || []).map((r) => `<tr><td class="mono">${ui.fmtDate(r.ts)}</td><td><span class="mono" style="color:var(--text-soft)">${h(r.model)}</span></td><td>${statusPill(r.status, r.http_status)}</td><td class="num">${ui.duration(r.latency_ms)}</td><td class="num">${ui.compact(r.total_tokens)}</td><td class="num">${ui.usd(r.cost_usd)}</td><td>${providerPill(r.provider)}</td></tr>`).join('') || `<tr><td colspan="7">${ui.emptyState('暂无请求', '', 'activity')}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
    el.querySelectorAll('#metric-seg button').forEach((btn) => {
      btn.addEventListener('click', () => {
        metric = btn.dataset.metric;
        el.querySelectorAll('#metric-seg button').forEach((b) => b.classList.toggle('active', b === btn));
        renderChart();
      });
    });
    el.querySelector('#refresh-overview')?.addEventListener('click', () => load(true));
    el.querySelector('#go-channels')?.addEventListener('click', () => ctx.navigate('admin', 'channels'));
    renderChart();
  };

  const load = async (silent = false) => {
    try {
      data = await api('/api/admin/overview');
      render();
    } catch (err) {
      if (!silent) loadError(el, err);
      else ui.toast(`刷新失败：${err.message}`, 'error');
    }
  };

  await load();
  timer = setInterval(() => { if (!document.hidden) load(true); }, 20000);
  return () => clearInterval(timer);
}

/* =====================================================================
 *  CHANNELS
 * ===================================================================== */
async function channels(el, ctx) {
  let items = [];
  let catalog = [];
  const canManage = ctx.state.permissions.manage_platform;

  const load = async () => {
    const [channelRes, modelRes] = await Promise.all([api('/api/admin/channels'), api('/api/admin/model-catalog')]);
    items = channelRes.items;
    catalog = modelRes.items;
    render();
  };

  const modelRowsHtml = (mappings = []) => mappings.map((m) => `
    <div class="model-map-row" style="display:grid;grid-template-columns:1.1fr 1.1fr auto auto;gap:8px;align-items:center;margin-bottom:8px">
      <select class="mm-alias">${modelOptions(catalog, m.model_alias || m.alias || '')}</select>
      <input class="mm-upstream" placeholder="上游真实模型 ID" value="${h(m.upstream_model || '')}" />
      <label class="checkline"><input type="checkbox" class="mm-enabled" ${m.enabled !== 0 ? 'checked' : ''}/> 启用</label>
      <button type="button" class="icon-btn danger" data-remove-row title="移除">${ui.icon('trash', 15)}</button>
    </div>`).join('') || '<div class="muted-2 text-xs" id="no-map">暂无映射，点击下方按钮添加</div>';

  const openEdit = (channel = null) => {
    const isEdit = !!channel;
    const modal = ui.openModal({
      title: isEdit ? `编辑渠道 · ${channel.name}` : '添加上游渠道',
      subtitle: isEdit ? '变更会立即刷新路由快照，并重新进行健康探测' : '配置供应商协议、Master Key 池与模型映射',
      size: 'wide',
      body: `<form id="channel-form">
        <div class="form-section">
          <div class="form-grid">
            <div class="field"><label>渠道名称 <span class="req">*</span></label><input name="name" value="${h(channel?.name || '')}" placeholder="例如：OpenAI 官方主通道" required /></div>
            <div class="field"><label>供应商类型 <span class="req">*</span></label><select name="provider" id="provider-select">${PROVIDERS.map((p) => `<option value="${p.id}" ${channel?.provider === p.id ? 'selected' : ''}>${p.name} · ${p.proto}</option>`).join('')}</select></div>
            <div class="field span-2"><label>Base URL <span class="req">*</span></label><input name="base_url" value="${h(channel?.base_url || '')}" placeholder="https://api.openai.com/v1" required /><div class="help">对于 OpenAI 兼容协议，请填写包含 /v1 的完整 Base URL；Anthropic 填写 https://api.anthropic.com；Azure 填写资源域名。</div></div>
            <div class="field"><label>API Version（Azure 专用）</label><input name="api_version" value="${h(channel?.api_version || '')}" placeholder="2024-06-01" /></div>
            <div class="field"><label>单渠道并发上限</label><input name="concurrency_limit" type="number" min="0" value="${channel?.concurrency_limit ?? 0}" /><div class="help">0 表示不单独限制</div></div>
          </div>
        </div>
        <div class="form-section">
          <div class="form-section-title">路由与超时</div>
          <div class="form-grid">
            <div class="field"><label>优先级（1 最高）</label><input name="priority" type="number" min="1" max="10" value="${channel?.priority ?? 5}" /></div>
            <div class="field"><label>权重（1-100）</label><input name="weight" type="number" min="1" max="100" value="${channel?.weight ?? 10}" /></div>
            <div class="field"><label>总超时（ms）</label><input name="timeout_ms" type="number" min="1000" value="${channel?.timeout_ms ?? 60000}" /></div>
            <div class="field"><label>首字超时（ms）</label><input name="first_byte_timeout_ms" type="number" min="1000" value="${channel?.first_byte_timeout_ms ?? 30000}" /></div>
          </div>
        </div>
        <div class="form-section">
          <div class="form-section-title">模型映射</div>
          <div id="model-rows">${modelRowsHtml(channel?.models || [])}</div>
          <button type="button" class="btn sm mt-8" id="add-model-row">${ui.icon('plus', 14)} 添加模型映射</button>
          <div class="help mt-8">左侧为平台对外暴露的模型别名，右侧为该渠道上游的真实模型 ID / Azure Deployment 名称。</div>
        </div>
        <div class="form-section">
          <div class="form-section-title">Master Key 池</div>
          ${isEdit ? `<div class="notice">${ui.icon('info', 16)} 当前渠道已有 ${channel.key_count} 个上游 Key。可在渠道列表的「Key 管理」中查看与删除，或在下方追加新 Key。</div>
          <div class="field mt-12"><label>追加上游 Key（每行一个）</label><textarea name="keys" placeholder="sk-..."></textarea></div>` : `<div class="field"><label>上游 Master Key <span class="req">*</span></label><textarea name="keys" placeholder="每行一个 Key，将使用 AES-256-GCM 加密存储"></textarea><div class="help">支持多 Key 轮询，用于分散单 Key 的并发限制。</div></div>`}
        </div>
        <div class="form-section">
          <div class="form-section-title">自定义请求头</div>
          <div class="field"><label>Headers（JSON）</label><textarea name="headers" placeholder='{"X-Custom-Header":"value"}'>${h(JSON.stringify(channel?.headers || {}, null, 2))}</textarea><div class="help">用于内网鉴权、组织标识等额外请求头，不会覆盖 Authorization / api-key。</div></div>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="save-channel">${ui.icon('check', 15)} ${isEdit ? '保存变更' : '创建渠道'}</button>`,
      onMount(modalEl, close) {
        const form = modalEl.querySelector('#channel-form');
        const providerSel = modalEl.querySelector('#provider-select');
        const baseInput = form.querySelector('[name="base_url"]');
        providerSel.addEventListener('change', () => {
          const p = PROVIDERS.find((x) => x.id === providerSel.value);
          if (p && !baseInput.value) baseInput.value = p.base;
          if (p && baseInput.placeholder === '') baseInput.placeholder = p.base;
        });
        modalEl.querySelector('#add-model-row').addEventListener('click', () => {
          modalEl.querySelector('#no-map')?.remove();
          const wrap = document.createElement('div');
          wrap.innerHTML = modelRowsHtml([{ model_alias: '', upstream_model: '', enabled: 1 }]);
          modalEl.querySelector('#model-rows').appendChild(wrap.firstElementChild);
        });
        modalEl.querySelector('#model-rows').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove-row]');
          if (btn) btn.closest('.model-map-row').remove();
        });
        modalEl.querySelector('#save-channel').addEventListener('click', async () => {
          const btn = modalEl.querySelector('#save-channel');
          const models = [...modalEl.querySelectorAll('.model-map-row')].map((row) => ({
            alias: row.querySelector('.mm-alias').value,
            upstream_model: row.querySelector('.mm-upstream').value.trim(),
            enabled: row.querySelector('.mm-enabled').checked,
          })).filter((m) => m.alias && m.upstream_model);
          let headers = {};
          try { headers = form.headers.value.trim() ? JSON.parse(form.headers.value) : {}; } catch { ui.toast('Headers 不是合法 JSON', 'error'); return; }
          const keys = form.keys.value.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
          const payload = {
            name: form.name.value.trim(),
            provider: form.provider.value,
            base_url: form.base_url.value.trim(),
            api_version: form.api_version.value.trim() || null,
            priority: Number(form.priority.value),
            weight: Number(form.weight.value),
            timeout_ms: Number(form.timeout_ms.value),
            first_byte_timeout_ms: Number(form.first_byte_timeout_ms.value),
            concurrency_limit: Number(form.concurrency_limit.value),
            headers,
            models,
            keys,
          };
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> 保存中…';
          try {
            if (isEdit) await api(`/api/admin/channels/${channel.id}`, { method: 'PUT', body: payload });
            else await api('/api/admin/channels', { method: 'POST', body: payload });
            close();
            ui.toast(isEdit ? '渠道已更新' : '渠道已创建', 'success');
            await load();
          } catch (err) {
            ui.toast(err.message, 'error');
            btn.disabled = false;
            btn.innerHTML = `${ui.icon('check', 15)} ${isEdit ? '保存变更' : '创建渠道'}`;
          }
        });
      },
    });
    return modal;
  };

  const openKeyDrawer = (channel) => {
    const body = () => `
      <div class="notice mb-16">${ui.icon('lock', 16)} 上游 Key 使用 AES-256-GCM 加密存储，界面仅展示末四位提示。</div>
      <div id="channel-key-list">
        ${(channel.keys || []).length ? channel.keys.map((k) => `<div class="flex-between" style="padding:11px 0;border-bottom:1px solid var(--border)"><div><div class="mono text-sm">${h(k.hint)}</div><div class="text-xs muted-2">最近使用：${ui.timeAgo(k.last_used_at)} · 创建：${ui.fmtDate(k.created_at, false)}</div></div><div class="flex gap-8">${ui.badge(k.status === 'active' ? '启用' : '停用', k.status === 'active' ? 'green' : 'gray')}<button class="icon-btn danger" data-del-key="${k.id}" title="删除">${ui.icon('trash', 15)}</button></div></div>`).join('') : ui.emptyState('暂无上游 Key', '请先添加 Master Key', 'key')}
      </div>
      <div class="divider"></div>
      <div class="field"><label>添加 Key（每行一个）</label><textarea id="new-channel-keys" placeholder="sk-..."></textarea></div>
      <button class="btn primary mt-12" id="add-channel-keys">${ui.icon('plus', 15)} 添加</button>`;
    const drawer = ui.openDrawer({ title: `Key 管理 · ${channel.name}`, subtitle: `${channel.key_count} 个上游 Key`, body: body() });
    const bind = () => {
      drawer.el.querySelector('#add-channel-keys')?.addEventListener('click', async () => {
        const keys = drawer.el.querySelector('#new-channel-keys').value.split(/\r?\n/).map((k) => k.trim()).filter(Boolean);
        if (!keys.length) { ui.toast('请输入至少一个 Key', 'error'); return; }
        try {
          await api(`/api/admin/channels/${channel.id}/keys`, { method: 'POST', body: { keys } });
          ui.toast('Key 已添加', 'success');
          drawer.close();
          await load();
        } catch (err) { ui.toast(err.message, 'error'); }
      });
      drawer.el.querySelectorAll('[data-del-key]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!(await ui.confirmDialog({ title: '删除上游 Key', message: '确定删除该上游 Key？使用该 Key 的在途请求不受影响。', confirmText: '删除', danger: true }))) return;
          try {
            await api(`/api/admin/channels/${channel.id}/keys/${btn.dataset.delKey}`, { method: 'DELETE' });
            ui.toast('Key 已删除', 'success');
            drawer.close();
            await load();
          } catch (err) { ui.toast(err.message, 'error'); }
        });
      });
    };
    bind();
  };

  const doAction = async (action, channel) => {
    try {
      if (action === 'test') {
        ui.toast('正在测试渠道连通性…', 'info', 1800);
        const r = await api(`/api/admin/channels/${channel.id}/test`, { method: 'POST' });
        ui.toast(r.ok ? `连通正常 · ${r.latency_ms}ms` : `探测失败：${r.message}`, r.ok ? 'success' : 'error', 5000);
        await load();
      } else if (action === 'toggle') {
        const next = channel.status === 'enabled' ? 'disabled' : 'enabled';
        if (next === 'disabled' && !(await ui.confirmDialog({ title: '停用渠道', message: `停用「${channel.name}」后，其流量将立即切换至其他可用渠道。确定继续？`, confirmText: '停用', danger: true }))) return;
        await api(`/api/admin/channels/${channel.id}/toggle`, { method: 'POST', body: { status: next } });
        ui.toast(next === 'enabled' ? '渠道已启用' : '渠道已停用', 'success');
        await load();
      } else if (action === 'reset') {
        await api(`/api/admin/channels/${channel.id}/reset-circuit`, { method: 'POST' });
        ui.toast('断路器已重置', 'success');
        await load();
      } else if (action === 'edit') {
        openEdit(channel);
      } else if (action === 'keys') {
        openKeyDrawer(channel);
      } else if (action === 'delete') {
        if (!(await ui.confirmDialog({ title: '删除渠道', message: `确定删除「${channel.name}」？历史日志将保留，但该渠道的所有上游 Key 与模型映射会被移除。`, confirmText: '删除渠道', danger: true }))) return;
        await api(`/api/admin/channels/${channel.id}`, { method: 'DELETE' });
        ui.toast('渠道已删除', 'success');
        await load();
      }
    } catch (err) { ui.toast(err.message, 'error', 5000); }
  };

  const render = () => {
    el.innerHTML = `
      ${pageHead(ctx, '渠道管理', '纳管上游供应商与 Master Key 池，按优先级 / 权重 / 健康度调度流量', canManage ? `<button class="btn primary" id="add-channel">${ui.icon('plus', 15)} 添加渠道</button>` : ui.badge('只读模式', 'gray'))}
      <div class="notice mb-16">${ui.icon('info', 16)}<div>渠道优先级数值越小越优先；同优先级按权重随机分配。连续 3 次失败或窗口错误率超过 25% 会触发熔断，冷却 30 秒后以半开状态探测恢复。</div></div>
      <div class="card">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>渠道</th><th>供应商</th><th>优先级 / 权重</th><th>模型映射</th><th>Key</th><th>健康状态</th><th class="num">今日调用</th>${canManage ? '<th class="num">操作</th>' : ''}</tr></thead>
            <tbody>
              ${items.map((c) => {
                const hs = channelHealth(c);
                const circuit = ui.circuitMeta(c.circuit?.state);
                return `<tr>
                  <td><div class="cell-main"><div class="stat-icon ${c.status === 'enabled' ? 'violet' : 'gray'}" style="width:32px;height:32px;border-radius:9px">${ui.icon('server', 15)}</div><div class="cell-stack"><span class="strong">${h(c.name)}</span><span class="cell-sub mono">${h(c.base_url)}</span></div></div></td>
                  <td>${providerPill(c.provider)}</td>
                  <td><span class="mono">P${c.priority}</span> <span class="muted-2">/</span> <span class="mono">W${c.weight}</span></td>
                  <td><span class="badge gray">${c.models.length} 个模型</span><div class="cell-sub" style="margin-top:3px">${h(c.models.slice(0, 2).map((m) => m.model_alias).join(', '))}${c.models.length > 2 ? '…' : ''}</div></td>
                  <td>${canManage ? `<button class="btn ghost sm" data-action="keys" data-id="${c.id}">${ui.icon('key', 13)} ${c.key_count}</button>` : `<span class="mono">${c.key_count}</span>`}</td>
                  <td><div class="flex gap-8" style="flex-wrap:wrap">${ui.badge(hs.label, hs.tone)}${c.circuit?.state !== 'closed' ? ui.badge(`熔断 ${circuit.label}`, circuit.tone) : ''}<span class="cell-sub">${c.health?.latency_ms ? `${c.health.latency_ms}ms` : ''}</span></div></td>
                  <td class="num">${ui.num(c.usage_today?.requests || 0)}<div class="cell-sub">${ui.usd(c.usage_today?.cost || 0)}</div></td>
                  ${canManage ? `<td><div class="row-actions">
                    <button class="icon-btn" data-action="test" data-id="${c.id}" title="连通性测试">${ui.icon('activity', 15)}</button>
                    <button class="icon-btn" data-action="toggle" data-id="${c.id}" title="${c.status === 'enabled' ? '停用' : '启用'}">${ui.icon('power', 15)}</button>
                    <button class="icon-btn" data-action="reset" data-id="${c.id}" title="重置熔断">${ui.icon('rotate-cw', 15)}</button>
                    <button class="icon-btn" data-action="edit" data-id="${c.id}" title="编辑">${ui.icon('edit', 15)}</button>
                    <button class="icon-btn danger" data-action="delete" data-id="${c.id}" title="删除">${ui.icon('trash', 15)}</button>
                  </div></td>` : ''}
                </tr>`;
              }).join('') || `<tr><td colspan="8">${ui.emptyState('还没有配置上游渠道', '添加上游供应商后即可开始转发请求', 'server')}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
    el.querySelector('#add-channel')?.addEventListener('click', () => openEdit());
    el.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const channel = items.find((c) => c.id === btn.dataset.id);
        if (channel) doAction(btn.dataset.action, channel);
      });
    });
  };

  await load();
}

/* =====================================================================
 *  MODELS
 * ===================================================================== */
async function models(el, ctx) {
  let items = [];
  let catalog = [];
  const canManage = ctx.state.permissions.manage_platform;

  const load = async () => {
    const [res, cat] = await Promise.all([api('/api/admin/models'), api('/api/admin/model-catalog')]);
    items = res.items;
    catalog = cat.items;
    render();
  };

  const openEdit = (model = null) => {
    const isEdit = !!model;
    const caps = model?.capabilities || ['chat'];
    const chain = model?.fallback_chain || [];
    ui.openModal({
      title: isEdit ? `编辑模型 · ${model.alias}` : '添加模型',
      subtitle: '模型别名是业务方请求时使用的统一标识，可在多个渠道上映射到不同上游模型',
      size: 'wide',
      body: `<form id="model-form">
        <div class="form-section">
          <div class="form-grid">
            <div class="field"><label>模型别名 <span class="req">*</span></label><input name="alias" value="${h(model?.alias || '')}" ${isEdit ? 'disabled' : ''} placeholder="例如：gpt-4o" /><div class="help">创建后不可修改；智能路由模型可使用 auto、smart-fast 等别名</div></div>
            <div class="field"><label>显示名称 <span class="req">*</span></label><input name="name" value="${h(model?.name || '')}" placeholder="例如：GPT-4o" /></div>
            <div class="field"><label>类型</label><select name="kind"><option value="model" ${model?.kind !== 'router' ? 'selected' : ''}>普通模型</option><option value="router" ${model?.kind === 'router' ? 'selected' : ''}>智能路由别名</option></select></div>
            <div class="field"><label>智能路由分组</label><input name="smart_group" value="${h(model?.smart_group || '')}" placeholder="fast / coding / reasoning / auto" /><div class="help">仅智能路由别名使用，对应系统设置中的 smart_routes.groups</div></div>
            <div class="field span-2"><label>描述</label><textarea name="description" placeholder="模型能力、适用场景…">${h(model?.description || '')}</textarea></div>
          </div>
        </div>
        <div class="form-section">
          <div class="form-section-title">能力与限制</div>
          <div class="form-grid">
            <div class="field"><label>上下文窗口（tokens）</label><input name="context_window" type="number" min="0" value="${model?.context_window ?? 0}" /></div>
            <div class="field"><label>最大输出 Tokens</label><input name="max_output_tokens" type="number" min="0" value="${model?.max_output_tokens ?? 0}" /></div>
            <div class="field"><label>输入价格（USD / 1K tokens）</label><input name="input_price" type="number" min="0" step="0.000001" value="${model?.input_price ?? 0}" /></div>
            <div class="field"><label>输出价格（USD / 1K tokens）</label><input name="output_price" type="number" min="0" step="0.000001" value="${model?.output_price ?? 0}" /></div>
            <div class="field span-2"><label>模型能力</label><div class="checkbox-grid">${CAPABILITIES.map((c) => `<label class="checkline"><input type="checkbox" class="cap-check" value="${c}" ${caps.includes(c) ? 'checked' : ''}/> ${ui.capabilityLabel(c)}</label>`).join('')}</div></div>
            <div class="field span-2"><label>降级回退链</label><input name="fallback_chain" value="${h(chain.join(', '))}" placeholder="例如：claude-3-5-sonnet, qwen-max" /><div class="help">主模型渠道全部不可用时，按顺序尝试这些模型别名（跨厂商降级）。</div></div>
            <div class="field span-2"><label class="checkline"><input type="checkbox" name="visible" ${model?.visible !== false ? 'checked' : ''}/> 在模型目录中对外可见</label></div>
          </div>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="save-model">${ui.icon('check', 15)} ${isEdit ? '保存变更' : '创建模型'}</button>`,
      onMount(modalEl, close) {
        const form = modalEl.querySelector('#model-form');
        modalEl.querySelector('#save-model').addEventListener('click', async () => {
          const btn = modalEl.querySelector('#save-model');
          const capabilities = [...modalEl.querySelectorAll('.cap-check:checked')].map((x) => x.value);
          const fallback = form.fallback_chain.value.split(',').map((x) => x.trim()).filter(Boolean);
          const payload = {
            name: form.name.value.trim(),
            description: form.description.value.trim(),
            kind: form.kind.value,
            smart_group: form.smart_group.value.trim() || null,
            context_window: Number(form.context_window.value),
            max_output_tokens: Number(form.max_output_tokens.value),
            input_price: Number(form.input_price.value),
            output_price: Number(form.output_price.value),
            capabilities,
            fallback_chain: fallback,
            visible: form.visible.checked,
          };
          if (!isEdit) payload.alias = form.alias.value.trim();
          if (!payload.name) { ui.toast('请填写显示名称', 'error'); return; }
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> 保存中…';
          try {
            if (isEdit) await api(`/api/admin/models/${encodeURIComponent(model.alias)}`, { method: 'PUT', body: payload });
            else await api('/api/admin/models', { method: 'POST', body: payload });
            close();
            ui.toast(isEdit ? '模型已更新' : '模型已创建', 'success');
            await load();
          } catch (err) {
            ui.toast(err.message, 'error', 5000);
            btn.disabled = false;
            btn.innerHTML = `${ui.icon('check', 15)} ${isEdit ? '保存变更' : '创建模型'}`;
          }
        });
      },
    });
  };

  const render = () => {
    el.innerHTML = `
      ${pageHead(ctx, '模型与路由', '统一别名解析 → 路由策略匹配 → 上游真实模型标识，三层映射对业务方完全透明', canManage ? `<button class="btn primary" id="add-model">${ui.icon('plus', 15)} 添加模型</button>` : ui.badge('只读模式', 'gray'))}
      <div class="notice mb-16">${ui.icon('route', 16)}<div>智能别名 <span class="inline-code">auto</span>、<span class="inline-code">smart-fast</span>、<span class="inline-code">smart-coding</span>、<span class="inline-code">smart-reasoning</span> 按 <a href="/admin#/settings" style="color:#c4b5fd">系统设置 → smart_routes</a> 中的分组自动选择目标模型。</div></div>
      <div class="card">
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>模型</th><th>类型</th><th>能力</th><th>上下文</th><th>价格 / 1K</th><th>渠道</th><th>回退链</th><th>可见</th>${canManage ? '<th class="num">操作</th>' : ''}</tr></thead>
            <tbody>
              ${items.map((m) => `<tr>
                <td><div class="cell-stack"><span class="strong mono" style="font-size:12.5px">${h(m.alias)}</span><span class="cell-sub">${h(m.name)}</span></div></td>
                <td>${m.kind === 'router' ? ui.badge('智能路由', 'violet') : ui.badge('普通模型', 'gray')}</td>
                <td><div class="cap-list">${(m.capabilities || []).map((c) => `<span class="cap">${h(ui.capabilityLabel(c))}</span>`).join('')}</div></td>
                <td class="mono">${m.context_window ? ui.compact(m.context_window) : '—'}</td>
                <td class="mono" style="font-size:11px">${m.kind === 'router' ? '—' : `${ui.price(m.input_price)} / ${ui.price(m.output_price)}`}</td>
                <td>${m.kind === 'router' ? `<span class="badge violet">动态路由</span><div class="cell-sub">按分组自动选择目标模型</div>` : `<span class="badge ${m.available ? 'green' : 'gray'}">${m.available ? '可用' : '不可用'}</span><div class="cell-sub">${m.channel_count} 个映射</div>`}</td>
                <td class="cell-sub">${h((m.fallback_chain || []).join(' → ') || '—')}</td>
                <td>${m.visible ? ui.badge('可见', 'cyan') : ui.badge('隐藏', 'gray')}</td>
                ${canManage ? `<td><div class="row-actions"><button class="icon-btn" data-edit="${h(m.alias)}" title="编辑">${ui.icon('edit', 15)}</button><button class="icon-btn danger" data-del="${h(m.alias)}" title="删除">${ui.icon('trash', 15)}</button></div></td>` : ''}
              </tr>`).join('') || `<tr><td colspan="9">${ui.emptyState('模型目录为空', '', 'layers')}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
    el.querySelector('#add-model')?.addEventListener('click', () => openEdit());
    el.querySelectorAll('[data-edit]').forEach((btn) => btn.addEventListener('click', () => openEdit(items.find((m) => m.alias === btn.dataset.edit))));
    el.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await ui.confirmDialog({ title: '删除模型', message: `确定删除模型「${btn.dataset.del}」？被渠道映射或回退链引用时将无法删除。`, confirmText: '删除', danger: true }))) return;
        try {
          await api(`/api/admin/models/${encodeURIComponent(btn.dataset.del)}`, { method: 'DELETE' });
          ui.toast('模型已删除', 'success');
          await load();
        } catch (err) { ui.toast(err.message, 'error', 5000); }
      });
    });
  };

  await load();
}

/* =====================================================================
 *  USERS & ORGS
 * ===================================================================== */
async function users(el, ctx) {
  const isSuper = ctx.state.user.role === 'SUPER_ADMIN';
  const canWrite = ctx.state.user.role !== 'AUDITOR';
  let tab = 'users';
  let userData = { items: [], total: 0, page: 1, pages: 1 };
  let orgs = [];
  let filters = { q: '', role: '', status: '', page: 1 };
  let orgsLoaded = false;

  const load = async () => {
    const url = new URLSearchParams();
    if (filters.q) url.set('q', filters.q);
    if (filters.role) url.set('role', filters.role);
    if (filters.status) url.set('status', filters.status);
    url.set('page', filters.page);
    url.set('page_size', '20');
    const [u, o] = await Promise.all([api(`/api/admin/users?${url}`), api('/api/admin/orgs')]);
    userData = u;
    orgs = o.items;
    orgsLoaded = true;
    render();
  };

  const refreshOrgsOnly = async () => {
    const o = await api('/api/admin/orgs');
    orgs = o.items;
    render();
  };

  const openUserModal = (user = null) => {
    const isEdit = !!user;
    const roleOptions = isSuper
      ? [['SUPER_ADMIN', '超级管理员'], ['ORG_ADMIN', '部门管理员'], ['APP_USER', '普通用户'], ['AUDITOR', '审计员']]
      : [['APP_USER', '普通用户'], ['AUDITOR', '审计员']];
    if (user && !roleOptions.some(([v]) => v === user.role)) roleOptions.push([user.role, ui.roleName(user.role)]);
    ui.openModal({
      title: isEdit ? `编辑用户 · ${user.name}` : '添加用户',
      subtitle: isEdit ? '冻结账号会同时吊销其名下所有 API Key' : '新用户将获得独立额度，并可通过 SSO 或密码登录',
      body: `<form id="user-form">
        <div class="form-grid">
          <div class="field"><label>姓名 <span class="req">*</span></label><input name="name" value="${h(user?.name || '')}" required /></div>
          <div class="field"><label>企业邮箱 <span class="req">*</span></label><input name="email" type="email" value="${h(user?.email || '')}" required /></div>
          <div class="field"><label>工号</label><input name="employee_no" value="${h(user?.employee_no || '')}" /></div>
          <div class="field"><label>角色</label><select name="role">${roleOptions.map(([v, l]) => `<option value="${v}" ${user?.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>所属组织</label><select name="org_id">${orgOptions(orgs, user?.org_id || ctx.state.user.org_id)}</select></div>
          <div class="field"><label>个人月度配额（USD，0 = 不限）</label><input name="monthly_quota_usd" type="number" min="0" step="0.01" value="${user?.monthly_quota_usd ?? 0}" /></div>
          ${isEdit ? `<div class="field"><label>账号状态</label><select name="status"><option value="active" ${user.status === 'active' ? 'selected' : ''}>正常</option><option value="frozen" ${user.status === 'frozen' ? 'selected' : ''}>冻结</option></select><div class="help">冻结后将立即吊销该用户所有活跃 Key</div></div>` : `<div class="field"><label>登录密码</label><input name="password" type="password" placeholder="留空则自动生成随机密码" /><div class="help">至少 8 位；使用 SSO 登录的用户可忽略</div></div>`}
        </div>
        ${isEdit ? `<div class="notice warn mt-16">${ui.icon('alert', 16)} 修改角色或组织会立即影响该用户的访问范围；将其状态设为冻结会吊销全部 API Key。</div>` : ''}
      </form>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="save-user">${ui.icon('check', 15)} ${isEdit ? '保存变更' : '创建用户'}</button>`,
      onMount(modalEl, close) {
        const form = modalEl.querySelector('#user-form');
        modalEl.querySelector('#save-user').addEventListener('click', async () => {
          const btn = modalEl.querySelector('#save-user');
          const body = {
            name: form.name.value.trim(),
            email: form.email.value.trim(),
            employee_no: form.employee_no.value.trim(),
            role: form.role.value,
            org_id: form.org_id.value,
            monthly_quota_usd: Number(form.monthly_quota_usd.value) || 0,
          };
          if (isEdit) body.status = form.status.value;
          else if (form.password.value) body.password = form.password.value;
          btn.disabled = true;
          try {
            const result = isEdit
              ? await api(`/api/admin/users/${user.id}`, { method: 'PUT', body })
              : await api('/api/admin/users', { method: 'POST', body });
            close();
            if (!isEdit && result.initial_password) {
              ui.openModal({
                title: '用户创建成功',
                size: 'narrow',
                body: `<div class="notice mb-16">${ui.icon('check-circle', 16)} 请将初始密码安全地交付给用户。</div><div class="one-time-key"><code>${h(result.initial_password)}</code><button class="btn sm" id="copy-pwd">${ui.icon('copy', 13)} 复制</button></div>`,
                footer: '<button class="btn primary" data-close>我已保存</button>',
                onMount(el2) { el2.querySelector('#copy-pwd').addEventListener('click', () => ui.copyText(result.initial_password)); },
              });
            }
            ui.toast(isEdit ? '用户已更新' : '用户已创建', 'success');
            await load();
          } catch (err) {
            ui.toast(err.message, 'error', 5000);
            btn.disabled = false;
          }
        });
      },
    });
  };

  const openPasswordModal = (user) => {
    ui.openModal({
      title: `重置密码 · ${user.name}`,
      size: 'narrow',
      body: `<form id="pwd-form"><div class="field"><label>新密码</label><input name="password" type="password" placeholder="至少 8 位" /></div></form>`,
      footer: '<button class="btn" data-close>取消</button><button class="btn primary" id="save-pwd">重置密码</button>',
      onMount(modalEl, close) {
        modalEl.querySelector('#save-pwd').addEventListener('click', async () => {
          const pwd = modalEl.querySelector('[name="password"]').value;
          if (pwd.length < 8) { ui.toast('密码至少需要 8 位', 'error'); return; }
          try {
            await api(`/api/admin/users/${user.id}/password`, { method: 'PUT', body: { password: pwd } });
            close();
            ui.toast('密码已重置', 'success');
          } catch (err) { ui.toast(err.message, 'error'); }
        });
      },
    });
  };

  const toggleFreeze = async (user) => {
    const freeze = user.status === 'active';
    if (freeze && !(await ui.confirmDialog({
      title: '冻结用户',
      message: `冻结「${user.name}」将立即吊销其名下所有 API Key，并阻止后续登录。确定继续？`,
      confirmText: '冻结并吊销',
      danger: true,
    }))) return;
    try {
      await api(`/api/admin/users/${user.id}`, { method: 'PUT', body: { status: freeze ? 'frozen' : 'active' } });
      ui.toast(freeze ? '用户已冻结，相关 Key 已吊销' : '用户已恢复', 'success');
      await load();
    } catch (err) { ui.toast(err.message, 'error', 5000); }
  };

  const openOrgModal = (org = null, parent = null) => {
    const isEdit = !!org;
    ui.openModal({
      title: isEdit ? `编辑组织 · ${org.name}` : '添加组织',
      size: 'narrow',
      body: `<form id="org-form">
        <div class="field"><label>组织名称 <span class="req">*</span></label><input name="name" value="${h(org?.name || '')}" /></div>
        <div class="field mt-12"><label>上级组织</label><select name="parent_id"><option value="">（作为根组织）</option>${orgOptions(orgs, org?.parent_id || parent?.id || '', { exclude: org?.id })}</select></div>
        <div class="field mt-12"><label>部门月度配额（USD，0 = 不限）</label><input name="monthly_quota_usd" type="number" min="0" step="0.01" value="${org?.monthly_quota_usd ?? 0}" /></div>
        ${isEdit ? `<div class="field mt-12"><label>状态</label><select name="status"><option value="active" ${org.status === 'active' ? 'selected' : ''}>正常</option><option value="disabled" ${org.status === 'disabled' ? 'selected' : ''}>停用</option></select></div>` : ''}
      </form>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="save-org">${isEdit ? '保存' : '创建组织'}</button>`,
      onMount(modalEl, close) {
        modalEl.querySelector('#save-org').addEventListener('click', async () => {
          const form = modalEl.querySelector('#org-form');
          const body = {
            name: form.name.value.trim(),
            parent_id: form.parent_id.value || null,
            monthly_quota_usd: Number(form.monthly_quota_usd.value) || 0,
          };
          if (isEdit) body.status = form.status.value;
          try {
            if (isEdit) await api(`/api/admin/orgs/${org.id}`, { method: 'PUT', body });
            else await api('/api/admin/orgs', { method: 'POST', body });
            close();
            ui.toast(isEdit ? '组织已更新' : '组织已创建', 'success');
            await load();
          } catch (err) { ui.toast(err.message, 'error', 5000); }
        });
      },
    });
  };

  const openImport = () => {
    const template = '姓名,邮箱,角色,组织,月度配额,密码\n张三,zhangsan@corp.local,APP_USER,算法平台,50,\n李四,lisi@corp.local,APP_USER,技术中心,0,Passw0rd!';
    ui.openModal({
      title: '批量导入用户',
      subtitle: '每行一个用户；角色可选 APP_USER / ORG_ADMIN / AUDITOR，密码留空则自动生成',
      size: 'wide',
      body: `<div class="notice mb-12">${ui.icon('info', 16)} CSV 格式：姓名,邮箱,角色,组织,月度配额,密码。组织可填名称或留空继承当前管理员组织；单次最多 200 人。</div>
        <div class="field"><label>用户数据</label><textarea id="import-csv" style="min-height:220px;font-family:var(--mono);font-size:11.5px" placeholder="${h(template)}"></textarea></div>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="do-import">${ui.icon('user-plus', 15)} 开始导入</button>`,
      onMount(modalEl, close) {
        modalEl.querySelector('#do-import').addEventListener('click', async () => {
          const lines = modalEl.querySelector('#import-csv').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          if (!lines.length) { ui.toast('请粘贴用户数据', 'error'); return; }
          const users = [];
          for (const [idx, line] of lines.entries()) {
            if (idx === 0 && /^(姓名|name)$/i.test(line.split(',')[0].trim())) continue;
            const cols = line.split(',').map((c) => c.trim());
            const [name, email, role, orgName, quota, password] = cols;
            if (!name || !email) { ui.toast(`第 ${idx + 1} 行缺少姓名或邮箱`, 'error'); return; }
            users.push({ name, email, role: role || 'APP_USER', org_name: orgName || '', monthly_quota_usd: Number(quota) || 0, password: password || '' });
          }
          if (!users.length) { ui.toast('没有可导入的数据', 'error'); return; }
          const btn = modalEl.querySelector('#do-import');
          btn.disabled = true;
          btn.innerHTML = '<span class="spinner"></span> 导入中…';
          try {
            const result = await api('/api/admin/users/import', { method: 'POST', body: { users } });
            close();
            await load();
            const creds = result.credentials.map((c) => `${c.name},${c.email},${c.password}`).join('\n');
            ui.openModal({
              title: '导入完成',
              size: 'wide',
              body: `<div class="grid grid-3 mb-16">
                <div class="stat"><div class="stat-label">成功创建</div><div class="stat-value">${result.created}</div></div>
                <div class="stat"><div class="stat-label">跳过 / 失败</div><div class="stat-value">${result.skipped}</div></div>
                <div class="stat"><div class="stat-label">校验错误</div><div class="stat-value">${result.errors.length}</div></div>
              </div>
              ${result.errors.length ? `<div class="notice warn mb-12">${ui.icon('alert', 16)}<div>${result.errors.slice(0, 10).map((e) => `第 ${e.row} 行：${h(e.message)}`).join('<br/>')}</div></div>` : ''}
              ${creds ? `<div class="field"><label>初始登录凭据（请立即保存并分发）</label><textarea readonly style="min-height:150px;font-family:var(--mono)">${h(`姓名,邮箱,密码\n${creds}`)}</textarea></div>` : ''}`,
              footer: `<button class="btn" data-close>关闭</button>${creds ? `<button class="btn primary" id="copy-import-creds">${ui.icon('copy', 14)} 复制凭据</button>` : ''}`,
              onMount(el2) { el2.querySelector('#copy-import-creds')?.addEventListener('click', () => ui.copyText(`姓名,邮箱,密码\n${creds}`)); },
            });
          } catch (err) {
            ui.toast(err.message, 'error', 6000);
            btn.disabled = false;
            btn.innerHTML = `${ui.icon('user-plus', 15)} 开始导入`;
          }
        });
      },
    });
  };

  const renderUsersTab = () => `
    <div class="card">
      <div class="table-toolbar">
        <form class="filter-grid" id="user-filter">
          <div class="field grow"><div class="input-icon">${ui.icon('search', 15)}<input class="search-input" name="q" value="${h(filters.q)}" placeholder="搜索姓名 / 邮箱 / 工号" /></div></div>
          <div class="field"><select name="role"><option value="">全部角色</option>${['SUPER_ADMIN', 'ORG_ADMIN', 'APP_USER', 'AUDITOR'].map((r) => `<option value="${r}" ${filters.role === r ? 'selected' : ''}>${ui.roleName(r)}</option>`).join('')}</select></div>
          <div class="field"><select name="status"><option value="">全部状态</option><option value="active" ${filters.status === 'active' ? 'selected' : ''}>正常</option><option value="frozen" ${filters.status === 'frozen' ? 'selected' : ''}>冻结</option></select></div>
          <button class="btn" type="submit">${ui.icon('search', 14)} 查询</button>
          <button class="btn ghost" type="button" id="reset-user-filter">重置</button>
        </form>
        <div class="spacer"></div>
        ${canWrite ? `<button class="btn" id="import-users">${ui.icon('download', 15)} 批量导入</button><button class="btn primary" id="add-user">${ui.icon('user-plus', 15)} 添加用户</button>` : ui.badge('只读模式', 'gray')}
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>用户</th><th>角色</th><th>所属组织</th><th>额度</th><th>API Key</th><th>状态</th><th>最近登录</th>${canWrite ? '<th class="num">操作</th>' : ''}</tr></thead>
          <tbody>
            ${userData.items.map((u) => `<tr>
              <td><div class="cell-main"><div class="avatar" style="width:30px;height:30px;border-radius:8px;font-size:10px">${h(ui.initials(u.name))}</div><div class="cell-stack"><span class="strong">${h(u.name)}</span><span class="cell-sub">${h(u.email)}${u.employee_no ? ` · ${h(u.employee_no)}` : ''}</span></div></div></td>
              <td>${ui.badge(ui.roleName(u.role), ui.roleTone(u.role))}</td>
              <td>${h(u.org_name || '—')}</td>
              <td><div class="mono" style="font-size:11px">${ui.usd(u.spent_usd)} / ${u.monthly_quota_usd > 0 ? ui.usd(u.monthly_quota_usd) : '不限'}</div>${u.monthly_quota_usd > 0 ? `<div class="progress mt-8" style="width:110px"><div class="${u.spent_usd / u.monthly_quota_usd >= 0.85 ? 'danger' : ''}" style="width:${Math.min(100, (u.spent_usd / u.monthly_quota_usd) * 100)}%"></div></div>` : ''}</td>
              <td><span class="badge gray">${u.key_count} 个活跃</span></td>
              <td>${u.status === 'active' ? ui.badge('正常', 'green') : ui.badge('已冻结', 'red')}</td>
              <td class="cell-sub">${u.last_login_at ? ui.timeAgo(u.last_login_at) : '从未登录'}</td>
              ${canWrite ? `<td><div class="row-actions">
                <button class="icon-btn" data-user-edit="${u.id}" title="编辑">${ui.icon('edit', 15)}</button>
                <button class="icon-btn" data-user-pwd="${u.id}" title="重置密码">${ui.icon('lock', 15)}</button>
                <button class="icon-btn ${u.status === 'active' ? 'danger' : ''}" data-user-freeze="${u.id}" title="${u.status === 'active' ? '冻结' : '恢复'}">${ui.icon('power', 15)}</button>
              </div></td>` : ''}
            </tr>`).join('') || `<tr><td colspan="${canWrite ? 8 : 7}">${ui.emptyState('没有符合条件的用户', '', 'users')}</td></tr>`}
          </tbody>
        </table>
      </div>
      ${tableFoot(null, userData.total, userData.page, userData.pages)}
    </div>`;

  const renderOrgsTab = () => `
    <div class="card">
      <div class="table-toolbar">
        <div><div class="section-title">组织层级</div><div class="section-sub">公司 → 部门 → 项目组，逐级继承并汇总配额</div></div>
        <div class="spacer"></div>
        ${isSuper ? `<button class="btn primary" id="add-org">${ui.icon('plus', 15)} 添加组织</button>` : ''}
      </div>
      <div class="table-wrap">
        <table class="data">
          <thead><tr><th>组织</th><th>层级</th><th class="num">成员</th><th>月度配额</th><th class="num">本月消费</th><th>状态</th>${isSuper ? '<th class="num">操作</th>' : ''}</tr></thead>
          <tbody>
            ${orgs.sort((a, b) => a.path.localeCompare(b.path)).map((o) => {
              const depth = Math.max(0, o.path.split('/').length - 2);
              return `<tr>
                <td><span class="tree-indent">${'　'.repeat(depth)}${depth ? '└ ' : ''}</span><span class="strong">${h(o.name)}</span></td>
                <td class="cell-sub">${depth === 0 ? '根组织' : depth === 1 ? '部门' : '项目组 / 子部门'}</td>
                <td class="num">${ui.num(o.user_count)}</td>
                <td class="mono">${o.monthly_quota_usd > 0 ? ui.usd(o.monthly_quota_usd) : '不限'}</td>
                <td class="num"><div>${ui.usd(o.spent_usd)}</div>${o.monthly_quota_usd > 0 ? `<div class="progress mt-8" style="width:100px;margin-left:auto"><div class="${o.spent_usd / o.monthly_quota_usd >= 0.85 ? 'danger' : ''}" style="width:${Math.min(100, (o.spent_usd / o.monthly_quota_usd) * 100)}%"></div></div>` : ''}</td>
                <td>${o.status === 'active' ? ui.badge('正常', 'green') : ui.badge('停用', 'red')}</td>
                ${isSuper ? `<td><div class="row-actions">
                  <button class="icon-btn" data-org-edit="${o.id}" title="编辑">${ui.icon('edit', 15)}</button>
                  <button class="icon-btn" data-org-add="${o.id}" title="添加子组织">${ui.icon('plus', 15)}</button>
                  <button class="icon-btn danger" data-org-del="${o.id}" title="删除">${ui.icon('trash', 15)}</button>
                </div></td>` : ''}
              </tr>`;
            }).join('') || `<tr><td colspan="7">${ui.emptyState('暂无组织', '', 'users')}</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  const bind = () => {
    el.querySelectorAll('[data-tab]').forEach((btn) => btn.addEventListener('click', () => { tab = btn.dataset.tab; render(); }));
    if (tab === 'users') {
      const form = el.querySelector('#user-filter');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        filters = { ...filters, q: form.q.value.trim(), role: form.role.value, status: form.status.value, page: 1 };
        load().catch((err) => ui.toast(err.message, 'error'));
      });
      el.querySelector('#reset-user-filter').addEventListener('click', () => {
        filters = { q: '', role: '', status: '', page: 1 };
        load().catch((err) => ui.toast(err.message, 'error'));
      });
      el.querySelector('#add-user')?.addEventListener('click', () => openUserModal());
      el.querySelector('#import-users')?.addEventListener('click', openImport);
      el.querySelectorAll('[data-user-edit]').forEach((btn) => btn.addEventListener('click', () => openUserModal(userData.items.find((u) => u.id === btn.dataset.userEdit))));
      el.querySelectorAll('[data-user-pwd]').forEach((btn) => btn.addEventListener('click', () => openPasswordModal(userData.items.find((u) => u.id === btn.dataset.userPwd))));
      el.querySelectorAll('[data-user-freeze]').forEach((btn) => btn.addEventListener('click', () => toggleFreeze(userData.items.find((u) => u.id === btn.dataset.userFreeze))));
      ui.attachPagination(el.querySelector('.table-foot'), (page) => { filters.page = page; load().catch((err) => ui.toast(err.message, 'error')); });
    } else {
      el.querySelector('#add-org')?.addEventListener('click', () => openOrgModal());
      el.querySelectorAll('[data-org-edit]').forEach((btn) => btn.addEventListener('click', () => openOrgModal(orgs.find((o) => o.id === btn.dataset.orgEdit))));
      el.querySelectorAll('[data-org-add]').forEach((btn) => btn.addEventListener('click', () => openOrgModal(null, orgs.find((o) => o.id === btn.dataset.orgAdd))));
      el.querySelectorAll('[data-org-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!(await ui.confirmDialog({ title: '删除组织', message: '仅允许删除没有子组织且没有成员的组织。确定继续？', confirmText: '删除', danger: true }))) return;
          try {
            await api(`/api/admin/orgs/${btn.dataset.orgDel}`, { method: 'DELETE' });
            ui.toast('组织已删除', 'success');
            await refreshOrgsOnly();
          } catch (err) { ui.toast(err.message, 'error', 5000); }
        });
      });
    }
  };

  const render = () => {
    el.innerHTML = `
      ${pageHead(ctx, '用户与组织', '统一管理成员、角色与组织预算；冻结账号会同步吊销其全部 API Key', `<span class="env-pill">${ui.icon('users', 13)} ${ui.num(userData.total)} 名成员</span>`)}
      <div class="tabs">
        <button data-tab="users" class="${tab === 'users' ? 'active' : ''}">用户管理</button>
        <button data-tab="orgs" class="${tab === 'orgs' ? 'active' : ''}">组织架构</button>
      </div>
      ${tab === 'users' ? renderUsersTab() : renderOrgsTab()}`;
    bind();
  };

  await load();
}

/* =====================================================================
 *  ADMIN KEYS
 * ===================================================================== */
async function adminKeys(el, ctx) {
  const canWrite = !ctx.state.permissions.read_only;
  let data = { items: [], total: 0, page: 1, pages: 1 };
  let users = [];
  let models = [];
  let filters = { q: '', status: '', page: 1 };

  const load = async () => {
    const url = new URLSearchParams();
    if (filters.q) url.set('q', filters.q);
    if (filters.status) url.set('status', filters.status);
    url.set('page', filters.page);
    url.set('page_size', '20');
    const [k, u, m] = await Promise.all([
      api(`/api/admin/keys?${url}`),
      api('/api/admin/users?page_size=200'),
      api('/api/admin/model-catalog'),
    ]);
    data = k;
    users = u.items;
    models = m.items;
    render();
  };

  const openIssue = () => {
    ui.openModal({
      title: '签发 API Key',
      subtitle: '明文密钥仅在创建成功时展示一次，请立即交付给使用方',
      body: `<form id="issue-form">
        <div class="form-grid">
          <div class="field span-2"><label>归属用户 <span class="req">*</span></label><select name="user_id">${users.map((u) => `<option value="${u.id}">${h(u.name)} · ${h(u.email)}</option>`).join('')}</select></div>
          <div class="field"><label>Key 名称 <span class="req">*</span></label><input name="name" placeholder="例如：Prod-Service" /></div>
          <div class="field"><label>标签</label><input name="tags" placeholder="DEV, PROD" /><div class="help">SUPER_ADMIN 可设置 PROD 以获得透支白名单</div></div>
          <div class="field"><label>月度限额（USD，0 不限）</label><input name="monthly_limit_usd" type="number" min="0" value="0" /></div>
          <div class="field"><label>总额度（USD，0 不限）</label><input name="total_limit_usd" type="number" min="0" value="0" /></div>
          <div class="field"><label>QPS 上限（留空继承默认）</label><input name="qps_limit" type="number" min="1" /></div>
          <div class="field"><label>TPM 上限（留空继承默认）</label><input name="tpm_limit" type="number" min="1" /></div>
          <div class="field span-2"><label>模型白名单（留空 = 全部）</label><input name="allowed_models" placeholder="gpt-4o, claude-3-5-sonnet" /></div>
          <div class="field span-2"><label>IP CIDR 白名单（每行一个，留空 = 不限）</label><textarea name="ip_whitelist" placeholder="10.0.0.0/8"></textarea></div>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="issue-key">${ui.icon('key', 15)} 生成 Key</button>`,
      onMount(modalEl, close) {
        const form = modalEl.querySelector('#issue-form');
        modalEl.querySelector('#issue-key').addEventListener('click', async () => {
          const payload = {
            user_id: form.user_id.value,
            name: form.name.value.trim(),
            tags: form.tags.value.split(',').map((x) => x.trim()).filter(Boolean),
            monthly_limit_usd: Number(form.monthly_limit_usd.value) || 0,
            total_limit_usd: Number(form.total_limit_usd.value) || 0,
            qps_limit: form.qps_limit.value ? Number(form.qps_limit.value) : null,
            tpm_limit: form.tpm_limit.value ? Number(form.tpm_limit.value) : null,
            allowed_models: form.allowed_models.value.split(',').map((x) => x.trim()).filter(Boolean),
            ip_whitelist: form.ip_whitelist.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          };
          if (!payload.name) { ui.toast('请填写 Key 名称', 'error'); return; }
          try {
            const result = await api('/api/admin/keys', { method: 'POST', body: payload });
            close();
            ui.openModal({
              title: 'API Key 创建成功',
              size: 'narrow',
              body: `<div class="notice warn mb-16">${ui.icon('alert', 16)} 密钥仅显示一次，关闭后无法找回。</div><div class="one-time-key"><code>${h(result.plaintext)}</code><button class="btn sm" id="copy-new-key">${ui.icon('copy', 13)} 复制</button></div><div class="mt-16 text-xs muted">请通过安全渠道交付给 ${h(users.find((u) => u.id === payload.user_id)?.name || '用户')}。如需轮换，请吊销后重新签发。</div>`,
              footer: '<button class="btn primary" data-close>我已妥善保存</button>',
              onMount(el2) { el2.querySelector('#copy-new-key').addEventListener('click', () => ui.copyText(result.plaintext)); },
            });
            await load();
          } catch (err) { ui.toast(err.message, 'error', 5000); }
        });
      },
    });
  };

  const setKeyStatus = async (key, status) => {
    try {
      await api(`/api/admin/keys/${key.id}`, { method: 'PUT', body: { status } });
      ui.toast(status === 'active' ? 'Key 已启用' : status === 'disabled' ? 'Key 已停用' : 'Key 已吊销', 'success');
      await load();
    } catch (err) { ui.toast(err.message, 'error'); }
  };

  const render = () => {
    el.innerHTML = `
      ${pageHead(ctx, 'API Key 管理', '检索全平台密钥、查看配额消耗并执行强制停用或吊销', canWrite ? `<button class="btn primary" id="issue-key-btn">${ui.icon('key', 15)} 签发 Key</button>` : ui.badge('只读模式', 'gray'))}
      <div class="card">
        <div class="table-toolbar">
          <form class="filter-grid" id="key-filter">
            <div class="field grow"><div class="input-icon">${ui.icon('search', 15)}<input name="q" class="search-input" value="${h(filters.q)}" placeholder="搜索 Key 名称 / 掩码 / 用户" /></div></div>
            <div class="field"><select name="status"><option value="">全部状态</option><option value="active" ${filters.status === 'active' ? 'selected' : ''}>启用</option><option value="disabled" ${filters.status === 'disabled' ? 'selected' : ''}>停用</option><option value="revoked" ${filters.status === 'revoked' ? 'selected' : ''}>已吊销</option></select></div>
            <button class="btn" type="submit">${ui.icon('search', 14)} 查询</button>
          </form>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>Key</th><th>归属</th><th>标签</th><th>本月消耗</th><th>速率限制</th><th>模型范围</th><th>状态</th><th>最近使用</th>${canWrite ? '<th class="num">操作</th>' : ''}</tr></thead>
            <tbody>
              ${data.items.map((k) => `<tr>
                <td><div class="cell-stack"><span class="strong">${h(k.name)}</span><span class="cell-sub mono">${h(k.masked)}</span></div></td>
                <td><div class="cell-stack"><span>${h(k.user_name)}</span><span class="cell-sub">${h(k.user_email)}</span></div></td>
                <td>${(k.tags || []).map((t) => ui.tag(t)).join(' ') || '<span class="muted-2">—</span>'}</td>
                <td><div class="mono" style="font-size:11px">${ui.usd(k.month_spent_usd)}</div><div class="cell-sub">${k.monthly_limit_usd > 0 ? `限额 ${ui.usd(k.monthly_limit_usd)}` : '不限额'}</div>${k.monthly_limit_usd > 0 ? `<div class="progress mt-8" style="width:100px"><div class="${k.month_spent_usd / k.monthly_limit_usd >= 0.85 ? 'danger' : ''}" style="width:${Math.min(100, (k.month_spent_usd / k.monthly_limit_usd) * 100)}%"></div></div>` : ''}</td>
                <td class="mono" style="font-size:11px">${k.qps_limit || '默认'} QPS<div class="cell-sub">${k.tpm_limit ? ui.compact(k.tpm_limit) + ' TPM' : '默认 TPM'}</div></td>
                <td class="cell-sub">${k.allowed_models?.length ? h(k.allowed_models.slice(0, 2).join(', ')) + (k.allowed_models.length > 2 ? '…' : '') : '全部模型'}</td>
                <td>${k.status === 'active' ? ui.badge('启用', 'green') : k.status === 'disabled' ? ui.badge('停用', 'gray') : ui.badge('已吊销', 'red')}</td>
                <td class="cell-sub">${k.last_request_at ? ui.timeAgo(k.last_request_at) : k.last_used_at ? ui.timeAgo(k.last_used_at) : '从未'}</td>
                ${canWrite ? `<td><div class="row-actions">
                  ${k.status === 'active' ? `<button class="icon-btn" data-key-disable="${k.id}" title="停用">${ui.icon('power', 15)}</button>` : k.status === 'disabled' ? `<button class="icon-btn" data-key-enable="${k.id}" title="启用">${ui.icon('power', 15)}</button>` : ''}
                  ${k.status !== 'revoked' ? `<button class="icon-btn danger" data-key-revoke="${k.id}" title="吊销">${ui.icon('trash', 15)}</button>` : ''}
                </div></td>` : ''}
              </tr>`).join('') || `<tr><td colspan="9">${ui.emptyState('暂无 API Key', '', 'key')}</td></tr>`}
            </tbody>
          </table>
        </div>
        ${tableFoot(null, data.total, data.page, data.pages)}
      </div>`;
    el.querySelector('#issue-key-btn')?.addEventListener('click', openIssue);
    const form = el.querySelector('#key-filter');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      filters = { ...filters, q: form.q.value.trim(), status: form.status.value, page: 1 };
      load().catch((err) => ui.toast(err.message, 'error'));
    });
    el.querySelectorAll('[data-key-disable]').forEach((btn) => {
      const key = data.items.find((k) => k.id === btn.dataset.keyDisable);
      btn.addEventListener('click', () => setKeyStatus(key, 'disabled'));
    });
    el.querySelectorAll('[data-key-enable]').forEach((btn) => {
      const key = data.items.find((k) => k.id === btn.dataset.keyEnable);
      btn.addEventListener('click', () => setKeyStatus(key, 'active'));
    });
    el.querySelectorAll('[data-key-revoke]').forEach((btn) => {
      const key = data.items.find((k) => k.id === btn.dataset.keyRevoke);
      btn.addEventListener('click', async () => {
        if (!(await ui.confirmDialog({ title: '吊销 API Key', message: `确定吊销「${key.name}」？该操作会立即阻断使用此 Key 的所有请求，且不可恢复。`, confirmText: '吊销', danger: true }))) return;
        await setKeyStatus(key, 'revoked');
      });
    });
    ui.attachPagination(el.querySelector('.table-foot'), (page) => { filters.page = page; load().catch((err) => ui.toast(err.message, 'error')); });
  };

  await load();
}

/* =====================================================================
 *  LOGS
 * ===================================================================== */
function logDetailHtml(log) {
  const rows = [
    ['Request ID', `<span class="mono">${h(log.id)}</span>`],
    ['时间', ui.fmtDate(log.ts)],
    ['来源', sourceBadge(log.source)],
    ['端点', `<span class="mono">/v1/${log.endpoint === 'chat' ? 'chat/completions' : log.endpoint}</span>`],
    ['模型（对外）', `<span class="mono">${h(log.model)}</span>`],
    ['上游模型', `<span class="mono">${h(log.upstream_model || '—')}</span>`],
    ['渠道', `${h(log.channel_id || '—')} ${log.provider ? `· ${ui.providerName(log.provider)}` : ''}`],
    ['状态', `${statusPill(log.status, log.http_status)} <span class="mono text-xs">HTTP ${log.http_status}</span>`],
    ['延迟 / TTFT', `${ui.duration(log.latency_ms)} / ${ui.duration(log.ttft_ms)}`],
    ['Tokens', `${ui.num(log.prompt_tokens)} 输入 + ${ui.num(log.completion_tokens)} 输出 = <b>${ui.num(log.total_tokens)}</b> ${log.estimated ? '<span class="badge amber">估算</span>' : ''}`],
    ['成本', costHtml(log.cost_usd)],
    ['尝试次数', `${log.attempts}`],
    ['客户端 IP', `<span class="mono">${h(log.client_ip || '—')}</span>`],
    ['User / Key', `<span class="mono text-xs">${h(log.user_id || '—')}<br/>${h(log.key_id || '—')}</span>`],
  ];
  return `<dl class="kv">${rows.map(([k, v]) => `<dt>${h(k)}</dt><dd>${v}</dd>`).join('')}</dl>
    ${log.error_message ? `<div class="divider"></div><div class="notice danger">${ui.icon('alert', 16)}<div><b>${h(log.error_type || '错误')} · ${h(log.error_code || '')}</b><div class="mt-8 mono text-xs" style="white-space:pre-wrap">${h(log.error_message)}</div></div></div>` : ''}
    <div class="divider"></div>
    <div class="text-xs muted-2">${ui.icon('shield', 12)} 网关默认仅存储元数据与截断的错误摘要，不保存完整 Prompt / 生成内容。</div>`;
}

function openLogDrawer(log) {
  ui.openDrawer({
    title: '请求详情',
    subtitle: log.id,
    body: logDetailHtml(log),
    footer: `<button class="btn" data-close>关闭</button><button class="btn" id="copy-reqid">${ui.icon('copy', 14)} 复制 Request ID</button>`,
    onMount(el) {
      el.querySelector('#copy-reqid')?.addEventListener('click', () => ui.copyText(log.id));
    },
  });
}

async function logs(el, ctx) {
  let data = { items: [], total: 0, page: 1, pages: 1 };
  let filters = { q: '', status: '', model: '', source: '', from: '', to: '', page: 1 };
  let autoTimer = null;
  let auto = false;

  const toQuery = () => {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.status) p.set('status', filters.status);
    if (filters.model) p.set('model', filters.model);
    if (filters.source) p.set('source', filters.source);
    if (filters.from) p.set('from', `${filters.from}T00:00:00`);
    if (filters.to) p.set('to', `${filters.to}T23:59:59`);
    p.set('page', filters.page);
    p.set('page_size', '30');
    return p;
  };

  const load = async (silent = false) => {
    try {
      data = await api(`/api/admin/logs?${toQuery()}`);
      render();
    } catch (err) {
      if (!silent) throw err;
    }
  };

  const render = () => {
    el.innerHTML = `
      ${pageHead(ctx, '调用日志', '记录 RequestID、模型、渠道、延迟、Token 与错误原因；不落盘 Prompt 内容', `
        <label class="checkline" style="margin-right:6px"><input type="checkbox" id="auto-refresh" ${auto ? 'checked' : ''}/> 自动刷新</label>
        <button class="btn" id="refresh-logs">${ui.icon('refresh', 15)} 刷新</button>`)}
      <div class="card">
        <div class="table-toolbar">
          <form class="filter-grid" id="log-filter">
            <div class="field grow"><div class="input-icon">${ui.icon('search', 15)}<input name="q" class="search-input" value="${h(filters.q)}" placeholder="Request ID / 模型 / 错误码" /></div></div>
            <div class="field"><select name="status"><option value="">全部状态</option><option value="success" ${filters.status === 'success' ? 'selected' : ''}>成功</option><option value="error" ${filters.status === 'error' ? 'selected' : ''}>失败</option><option value="cancelled" ${filters.status === 'cancelled' ? 'selected' : ''}>已取消</option></select></div>
            <div class="field"><input name="model" value="${h(filters.model)}" placeholder="模型别名" /></div>
            <div class="field"><select name="source"><option value="">全部来源</option><option value="api" ${filters.source === 'api' ? 'selected' : ''}>API</option><option value="playground" ${filters.source === 'playground' ? 'selected' : ''}>调试台</option></select></div>
            <div class="field"><input name="from" type="date" value="${h(filters.from)}" /></div>
            <div class="field"><input name="to" type="date" value="${h(filters.to)}" /></div>
            <button class="btn" type="submit">${ui.icon('filter', 14)} 筛选</button>
            <button class="btn ghost" type="button" id="reset-log-filter">重置</button>
          </form>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>时间</th><th>Request ID</th><th>模型</th><th>来源</th><th>状态</th><th class="num">延迟</th><th class="num">TTFT</th><th class="num">Tokens</th><th class="num">成本</th><th>渠道路径</th></tr></thead>
            <tbody>
              ${data.items.map((r) => `<tr class="clickable" data-log="${r.id}">
                <td class="mono" style="font-size:11px">${ui.fmtDate(r.ts)}</td>
                <td class="mono" style="font-size:10.5px;color:var(--muted-2)">${h(r.id.slice(0, 18))}…</td>
                <td><span class="mono" style="font-size:11.5px;color:var(--text-soft)">${h(r.model)}</span>${r.upstream_model && r.upstream_model !== r.model ? `<div class="cell-sub mono">→ ${h(r.upstream_model)}</div>` : ''}</td>
                <td>${sourceBadge(r.source)}</td>
                <td>${statusPill(r.status, r.http_status)}${r.http_status >= 400 ? `<div class="cell-sub">HTTP ${r.http_status}</div>` : ''}</td>
                <td class="num">${ui.duration(r.latency_ms)}</td>
                <td class="num">${ui.duration(r.ttft_ms)}</td>
                <td class="num">${ui.compact(r.total_tokens)}</td>
                <td class="num">${ui.usd(r.cost_usd)}</td>
                <td><span class="cell-sub">${h(ui.providerName(r.provider))}${r.attempts > 1 ? ` · ${r.attempts} 次尝试` : ''}</span></td>
              </tr>`).join('') || `<tr><td colspan="10">${ui.emptyState('暂无调用日志', '', 'list')}</td></tr>`}
            </tbody>
          </table>
        </div>
        ${tableFoot(null, data.total, data.page, data.pages)}
      </div>`;
    const form = el.querySelector('#log-filter');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      filters = { ...filters, q: form.q.value.trim(), status: form.status.value, model: form.model.value.trim(), source: form.source.value, from: form.from.value, to: form.to.value, page: 1 };
      load().catch((err) => ui.toast(err.message, 'error'));
    });
    el.querySelector('#reset-log-filter').addEventListener('click', () => {
      filters = { q: '', status: '', model: '', source: '', from: '', to: '', page: 1 };
      load().catch((err) => ui.toast(err.message, 'error'));
    });
    el.querySelector('#refresh-logs').addEventListener('click', () => load().catch((err) => ui.toast(err.message, 'error')));
    clearInterval(autoTimer);
    const autoEl = el.querySelector('#auto-refresh');
    autoEl.addEventListener('change', () => {
      auto = autoEl.checked;
      clearInterval(autoTimer);
      if (auto) autoTimer = setInterval(() => load(true), 10000);
    });
    if (auto) autoTimer = setInterval(() => load(true), 10000);
    el.querySelectorAll('[data-log]').forEach((row) => row.addEventListener('click', () => {
      const log = data.items.find((x) => x.id === row.dataset.log);
      if (log) openLogDrawer(log);
    }));
    ui.attachPagination(el.querySelector('.table-foot'), (page) => { filters.page = page; load().catch((err) => ui.toast(err.message, 'error')); });
  };

  await load();
  return () => clearInterval(autoTimer);
}

/* =====================================================================
 *  BILLING
 * ===================================================================== */
async function billing(el, ctx) {
  const today = new Date();
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  let filters = { from: dateInputValue(monthStart.getTime()), to: dateInputValue(today.getTime()), group_by: 'org' };
  let data = null;
  let daily = [];

  const load = async () => {
    const p = new URLSearchParams({ from: filters.from, to: filters.to, group_by: filters.group_by });
    const [b, d] = await Promise.all([
      api(`/api/admin/billing?${p}`),
      api('/api/admin/usage/daily?days=30'),
    ]);
    data = b;
    daily = d.items;
    render();
  };

  const exportCsv = async () => {
    try {
      const p = new URLSearchParams({ from: filters.from, to: filters.to, group_by: filters.group_by });
      await downloadCsv(`/api/admin/billing/export.csv?${p}`);
      ui.toast('账单已导出', 'success');
    } catch (err) { ui.toast(err.message, 'error'); }
  };

  const render = () => {
    const totalCost = Number(data.summary.cost_usd) || 0;
    const max = Math.max(0.000001, ...data.items.map((x) => Number(x.cost_usd) || 0));
    const groupNames = { org: '按部门', model: '按模型', user: '按用户', channel: '按渠道', provider: '按供应商', day: '按日期' };
    el.innerHTML = `
      ${pageHead(ctx, '财务报表', '按组织、模型、用户、日期维度核对 Token 消耗与成本分摊，可导出 CSV', `<button class="btn" id="export-csv">${ui.icon('download', 15)} 导出 CSV</button>`)}
      <div class="card mb-16">
        <div class="card-body">
          <form class="filter-grid" id="billing-filter">
            <div class="field"><label>开始日期</label><input name="from" type="date" value="${h(filters.from)}" /></div>
            <div class="field"><label>结束日期</label><input name="to" type="date" value="${h(filters.to)}" /></div>
            <div class="field"><label>统计维度</label><select name="group_by">${Object.entries(groupNames).map(([v, l]) => `<option value="${v}" ${filters.group_by === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
            <button class="btn primary" type="submit">${ui.icon('filter', 14)} 应用</button>
          </form>
        </div>
      </div>
      <div class="grid grid-4 mb-16">
        ${statCard({ label: '请求总数', value: ui.num(data.summary.requests), iconName: 'activity', tone: 'violet', meta: `成功率 ${data.summary.requests ? ((data.summary.successes / data.summary.requests) * 100).toFixed(1) : '100.0'}%` })}
        ${statCard({ label: '总 Tokens', value: ui.compact(data.summary.total_tokens), iconName: 'zap', tone: 'cyan', meta: `输入 ${ui.compact(data.summary.prompt_tokens)} · 输出 ${ui.compact(data.summary.completion_tokens)}` })}
        ${statCard({ label: '总成本（USD）', value: ui.usd(totalCost), iconName: 'wallet', tone: 'green', meta: `加价系数 ${data.markup_ratio}×` })}
        ${statCard({ label: '总成本（CNY）', value: ui.cny(totalCost, data.currency_rate), iconName: 'receipt', tone: 'amber', meta: `汇率 1 USD = ${data.currency_rate} CNY` })}
      </div>
      <div class="grid grid-2-1 mb-16">
        <div class="card">
          <div class="card-head"><div><div class="card-title">${ui.icon('bar-chart', 16)} 最近 30 天消费趋势</div><div class="card-desc">平台整体每日成本（USD）</div></div></div>
          <div class="card-body" id="billing-chart"></div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="card-title">${ui.icon('receipt', 16)} 对账说明</div><div class="card-desc">计费口径与导出</div></div></div>
          <div class="card-body">
            <div class="plan-list">
              <div class="plan-row"><span class="plan-name">计费依据</span><span class="plan-val">上游 usage</span></div>
              <div class="plan-row"><span class="plan-name">缺失兜底</span><span class="plan-val">本地估算</span></div>
              <div class="plan-row"><span class="plan-name">加价系数</span><span class="plan-val">${data.markup_ratio}×</span></div>
              <div class="plan-row"><span class="plan-name">导出格式</span><span class="plan-val">CSV / Excel</span></div>
            </div>
            <div class="notice mt-16">${ui.icon('info', 16)} 成本按每条请求的 Token 明细实时结算，导出文件包含 USD 与 CNY 两列，可直接用于部门费用分摊。</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">${h(groupNames[data.group_by] || '分组明细')}</div><div class="card-desc">${ui.fmtDate(data.from, false)} 至 ${ui.fmtDate(data.to - 1, false)} · Top ${data.items.length}</div></div></div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>分组</th><th class="num">请求数</th><th class="num">输入 Tokens</th><th class="num">输出 Tokens</th><th class="num">总 Tokens</th><th class="num">成本 USD</th><th class="num">成本 CNY</th><th style="width:160px">成本占比</th></tr></thead>
            <tbody>
              ${data.items.map((row) => `<tr>
                <td><span class="strong">${h(row.name)}</span></td>
                <td class="num">${ui.num(row.requests)}</td>
                <td class="num">${ui.compact(row.prompt_tokens)}</td>
                <td class="num">${ui.compact(row.completion_tokens)}</td>
                <td class="num">${ui.compact(row.total_tokens)}</td>
                <td class="num">${ui.usd(row.cost_usd)}</td>
                <td class="num">${ui.cny(row.cost_usd, data.currency_rate)}</td>
                <td><div class="bar-track"><div class="bar-fill" style="width:${Math.max(1, (row.cost_usd / max) * 100)}%"></div></div><div class="cell-sub mt-8">${totalCost ? ((row.cost_usd / totalCost) * 100).toFixed(1) : '0.0'}%</div></td>
              </tr>`).join('') || `<tr><td colspan="8">${ui.emptyState('该时间段暂无计费数据', '调整日期范围后重试', 'receipt')}</td></tr>`}
            </tbody>
            <tfoot><tr><td style="font-weight:600">合计</td><td class="num">${ui.num(data.summary.requests)}</td><td class="num">${ui.compact(data.summary.prompt_tokens)}</td><td class="num">${ui.compact(data.summary.completion_tokens)}</td><td class="num">${ui.compact(data.summary.total_tokens)}</td><td class="num">${ui.usd(totalCost)}</td><td class="num">${ui.cny(totalCost, data.currency_rate)}</td><td></td></tr></tfoot>
          </table>
        </div>
      </div>`;
    el.querySelector('#export-csv').addEventListener('click', exportCsv);
    const filter = el.querySelector('#billing-filter');
    filter.addEventListener('submit', (e) => {
      e.preventDefault();
      const from = filter.from.value;
      const to = filter.to.value;
      if (!from || !to) { ui.toast('请选择日期范围', 'error'); return; }
      filters = { from, to, group_by: filter.group_by.value };
      load().catch((err) => ui.toast(err.message, 'error'));
    });
    ui.areaChart(el.querySelector('#billing-chart'), {
      points: daily.map((d) => ({ ts: new Date(`${d.day}T00:00:00`).getTime(), cost: d.cost })),
      value: 'cost', color: '#34d399', label: '成本',
      format: (v) => ui.usd(v), xFormat: (ts) => ui.fmtDate(ts, false).slice(5),
    });
  };

  await load();
}

/* =====================================================================
 *  AUDIT
 * ===================================================================== */
async function audit(el, ctx) {
  let filters = { q: '', action: '', page: 1 };
  let data = { items: [], total: 0, page: 1, pages: 1 };

  const load = async () => {
    const p = new URLSearchParams();
    if (filters.q) p.set('q', filters.q);
    if (filters.action) p.set('action', filters.action);
    p.set('page', filters.page);
    p.set('page_size', '30');
    data = await api(`/api/admin/audit?${p}`);
    render();
  };

  const render = () => {
    el.innerHTML = `
      ${pageHead(ctx, '审计日志', '记录管理员的关键操作与登录安全事件，满足财务与合规审查要求', ui.badge('只读记录', 'gray'))}
      <div class="card">
        <div class="table-toolbar">
          <form class="filter-grid" id="audit-filter">
            <div class="field grow"><div class="input-icon">${ui.icon('search', 15)}<input name="q" class="search-input" value="${h(filters.q)}" placeholder="搜索操作人 / 目标 / 动作" /></div></div>
            <div class="field"><select name="action"><option value="">全部动作</option>${Object.entries(AUDIT_ACTIONS).map(([v, l]) => `<option value="${v}" ${filters.action === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
            <button class="btn" type="submit">${ui.icon('search', 14)} 查询</button>
          </form>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>目标</th><th>IP</th><th class="num">详情</th></tr></thead>
            <tbody>
              ${data.items.map((row) => `<tr>
                <td class="mono" style="font-size:11px">${ui.fmtDate(row.ts)}</td>
                <td><div class="cell-stack"><span>${h(row.actor_email || '匿名 / 系统')}</span><span class="cell-sub mono">${h(row.actor_id || '—')}</span></div></td>
                <td>${ui.badge(AUDIT_ACTIONS[row.action] || row.action, row.action.includes('failed') ? 'red' : row.action.includes('deleted') || row.action.includes('revoked') ? 'amber' : 'violet')}</td>
                <td><span class="mono" style="font-size:11px">${h(row.target_type || '—')}</span><div class="cell-sub mono">${h(row.target_id || '')}</div></td>
                <td class="mono" style="font-size:11px">${h(row.ip || '—')}</td>
                <td class="num"><button class="btn ghost sm" data-audit-detail="${row.id}">查看</button></td>
              </tr>`).join('') || `<tr><td colspan="6">${ui.emptyState('暂无审计记录', '', 'shield')}</td></tr>`}
            </tbody>
          </table>
        </div>
        ${tableFoot(null, data.total, data.page, data.pages)}
      </div>`;
    const form = el.querySelector('#audit-filter');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      filters = { q: form.q.value.trim(), action: form.action.value, page: 1 };
      load().catch((err) => ui.toast(err.message, 'error'));
    });
    el.querySelectorAll('[data-audit-detail]').forEach((btn) => btn.addEventListener('click', () => {
      const row = data.items.find((r) => r.id === btn.dataset.auditDetail);
      if (!row) return;
      ui.openDrawer({
        title: '审计事件详情',
        subtitle: row.id,
        body: `<dl class="kv">
          <dt>时间</dt><dd>${ui.fmtDate(row.ts)}</dd>
          <dt>操作人</dt><dd>${h(row.actor_email || '—')}<br/><span class="mono text-xs">${h(row.actor_id || '')}</span></dd>
          <dt>动作</dt><dd>${h(AUDIT_ACTIONS[row.action] || row.action)}<br/><span class="mono text-xs">${h(row.action)}</span></dd>
          <dt>目标</dt><dd>${h(row.target_type || '—')} / <span class="mono">${h(row.target_id || '—')}</span></dd>
          <dt>来源 IP</dt><dd class="mono">${h(row.ip || '—')}</dd>
        </dl><div class="divider"></div><pre class="code-block">${h(JSON.stringify(row.detail, null, 2) || 'null')}</pre>`,
        footer: '<button class="btn" data-close>关闭</button>',
      });
    }));
    ui.attachPagination(el.querySelector('.table-foot'), (page) => { filters.page = page; load().catch((err) => ui.toast(err.message, 'error')); });
  };

  await load();
}

/* =====================================================================
 *  SETTINGS
 * ===================================================================== */
const SETTING_GROUPS = [
  {
    title: '平台信息与计费', icon: 'globe', fields: [
      { key: 'platform.name', label: '平台名称', type: 'text' },
      { key: 'platform.currency', label: '展示币种', type: 'select', options: [['CNY', '人民币 CNY'], ['USD', '美元 USD']] },
      { key: 'platform.currency_rate', label: 'USD → CNY 汇率', type: 'number', step: '0.01' },
      { key: 'platform.markup_ratio', label: '成本加价系数', type: 'number', step: '0.01', help: '1.0 = 按上游成本原价核算；1.2 = 加价 20%' },
    ],
  },
  {
    title: '限流与请求策略', icon: 'gauge', fields: [
      { key: 'limits.default_qps', label: '默认 QPS / Key', type: 'number' },
      { key: 'limits.default_tpm', label: '默认 TPM / Key', type: 'number' },
      { key: 'limits.max_body_mb', label: '请求体上限（MB）', type: 'number' },
      { key: 'limits.max_attempts', label: '最大 Fallback 次数', type: 'number' },
      { key: 'limits.min_completion_reserve', label: '预估输出 Token 保留值', type: 'number' },
      { key: 'quota.soft_ratio', label: '软限额告警阈值', type: 'number', step: '0.01', help: '0.85 表示使用 85% 时触发告警' },
      { key: 'quota.overdraft_prod_ratio', label: 'PROD Key 透支比例', type: 'number', step: '0.01' },
      { key: 'logs.retention_days', label: '日志保留天数', type: 'number' },
      { key: 'routing.order_strategy', label: '渠道排序策略', type: 'select', options: [['weighted', '权重随机（Weighted RR）'], ['latency', '最低延迟优先']], help: '同优先级渠道的排序方式；跨优先级仍按 Priority 先后' },
    ],
  },
  {
    title: '断路器与健康探测', icon: 'activity', fields: [
      { key: 'circuit.failure_threshold', label: '连续失败阈值', type: 'number' },
      { key: 'circuit.window_size', label: '滑动窗口大小', type: 'number' },
      { key: 'circuit.error_rate', label: '窗口错误率阈值', type: 'number', step: '0.01' },
      { key: 'circuit.cooldown_ms', label: '熔断冷却时间（ms）', type: 'number' },
      { key: 'health.interval_ms', label: '健康探测间隔（ms）', type: 'number' },
      { key: 'sse.heartbeat_ms', label: 'SSE 心跳间隔（ms）', type: 'number' },
    ],
  },
  {
    title: '安全与登录', icon: 'shield', fields: [
      { key: 'security.local_login_enabled', label: '允许密码登录', type: 'bool', help: '生产环境建议仅保留企业 SSO 登录' },
      { key: 'security.session_ttl_hours', label: '会话有效期（小时）', type: 'number' },
      { key: 'sso.auto_create', label: 'SSO 自动创建用户', type: 'bool' },
      { key: 'sso.default_role', label: 'SSO 默认角色', type: 'select', options: [['APP_USER', '普通用户'], ['ORG_ADMIN', '部门管理员'], ['AUDITOR', '审计员']] },
      { key: 'sso.default_org_id', label: 'SSO 默认组织', type: 'org' },
    ],
  },
  {
    title: '告警通知', icon: 'mail', fields: [
      { key: 'alert.webhook_type', label: 'Webhook 类型', type: 'select', options: [['feishu', '飞书机器人'], ['wecom', '企业微信机器人'], ['generic', '通用 JSON']] },
      { key: 'alert.webhook_url', label: 'Webhook URL', type: 'text', span: true, help: '配额阈值、断路器熔断等事件将推送到此地址' },
    ],
  },
];

function settingFieldHtml(field, values, orgs) {
  const value = values[field.key] ?? '';
  const id = `set_${field.key.replace(/\./g, '_')}`;
  let input = '';
  if (field.type === 'select') {
    input = `<select id="${id}" data-setting="${field.key}">${(field.options || []).map(([v, l]) => `<option value="${v}" ${String(value) === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  } else if (field.type === 'bool') {
    input = `<select id="${id}" data-setting="${field.key}"><option value="true" ${String(value) === 'true' ? 'selected' : ''}>开启</option><option value="false" ${String(value) !== 'true' ? 'selected' : ''}>关闭</option></select>`;
  } else if (field.type === 'org') {
    input = `<select id="${id}" data-setting="${field.key}"><option value="">默认（首个组织）</option>${orgs.map((o) => `<option value="${o.id}" ${String(value) === o.id ? 'selected' : ''}>${h(o.name)}</option>`).join('')}</select>`;
  } else {
    input = `<input id="${id}" data-setting="${field.key}" type="${field.type}" ${field.step ? `step="${field.step}"` : ''} value="${h(value)}" ${field.type === 'number' ? 'min="0"' : ''} />`;
  }
  return `<div class="field ${field.span ? 'span-2' : ''}"><label for="${id}">${h(field.label)}</label>${input}${field.help ? `<div class="help">${h(field.help)}</div>` : ''}</div>`;
}

async function settingsPage(el, ctx) {
  if (ctx.state.user.role !== 'SUPER_ADMIN') {
    el.innerHTML = notice('仅超级管理员可以访问系统设置。', 'danger');
    return;
  }
  let settings = null;
  let orgs = [];
  let system = null;

  const load = async () => {
    const [s, o, sys] = await Promise.all([
      api('/api/admin/settings'),
      api('/api/admin/orgs'),
      api('/api/admin/system'),
    ]);
    settings = s;
    orgs = o.items;
    system = sys;
    render();
  };

  const providerCard = (p, idx) => `
    <div class="card" data-sso-idx="${idx}" style="background:rgba(255,255,255,.015);margin-bottom:10px">
      <div class="card-body" style="padding:14px">
        <div class="flex-between mb-12">
          <div class="flex-center gap-8">${ui.icon('shield', 15)}<b style="font-size:12.5px">${h(p.name || p.id || '新的 SSO 提供方')}</b>${p.enabled ? ui.badge('已启用', 'green') : ui.badge('未启用', 'gray')}</div>
          <div class="flex gap-8">
            <label class="checkline text-xs">启用 <input type="checkbox" data-sso-field="enabled" ${p.enabled ? 'checked' : ''}/></label>
            <button type="button" class="icon-btn danger" data-remove-sso="${idx}">${ui.icon('trash', 15)}</button>
          </div>
        </div>
        <div class="form-grid">
          <div class="field"><label>ID</label><input data-sso-field="id" value="${h(p.id || '')}" placeholder="feishu" /></div>
          <div class="field"><label>显示名称</label><input data-sso-field="name" value="${h(p.name || '')}" placeholder="飞书" /></div>
          <div class="field"><label>类型</label><select data-sso-field="type">${[['oidc', 'OIDC'], ['oauth2', 'OAuth2'], ['feishu', '飞书'], ['dingtalk', '钉钉']].map(([v, l]) => `<option value="${v}" ${p.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Client ID</label><input data-sso-field="client_id" value="${h(p.client_id || '')}" /></div>
          <div class="field"><label>Client Secret</label><input data-sso-field="client_secret" type="password" value="${h(p.client_secret || '')}" placeholder="留空表示不修改" /></div>
          <div class="field"><label>Issuer（OIDC）</label><input data-sso-field="issuer" value="${h(p.issuer || '')}" placeholder="https://idp.example.com" /></div>
          <div class="field"><label>Authorize URL（OAuth2）</label><input data-sso-field="authorize_url" value="${h(p.authorize_url || '')}" /></div>
          <div class="field"><label>Scope</label><input data-sso-field="scope" value="${h(p.scope || '')}" placeholder="openid profile email" /></div>
          <div class="field"><label>回调路径</label><input data-sso-field="redirect_path" value="${h(p.redirect_path || '')}" placeholder="/auth/sso/feishu/callback" /></div>
          <div class="field span-2"><label>回调地址（在 IdP 中配置）</label><input value="${h(p.callback_url || '')}" readonly /></div>
        </div>
      </div>
    </div>`;

  const render = () => {
    const values = settings.values;
    const providers = settings.sso_providers || [];
    el.innerHTML = `
      ${pageHead(ctx, '系统设置', '全局计费、限流、断路器、告警与 SSO 参数。修改将立即生效', `<button class="btn primary" id="save-settings">${ui.icon('check', 15)} 保存全部设置</button>`)}
      <div class="grid grid-2-1">
        <div class="stack">
          ${SETTING_GROUPS.map((group) => `
            <div class="card">
              <div class="settings-section">
                <div class="settings-head"><div class="settings-icon">${ui.icon(group.icon, 16)}</div><div><div class="settings-title">${h(group.title)}</div><div class="settings-desc">${group.fields.length} 项参数</div></div></div>
                <div class="form-grid">
                  ${group.fields.map((f) => settingFieldHtml(f, values, orgs)).join('')}
                </div>
              </div>
            </div>`).join('')}
          <div class="card">
            <div class="settings-section">
              <div class="settings-head"><div class="settings-icon">${ui.icon('branch', 16)}</div><div><div class="settings-title">智能路由分组</div><div class="settings-desc">smart_routes：定义 auto / smart-fast / smart-coding / smart-reasoning 的目标模型顺序</div></div></div>
              <div class="field"><textarea id="smart-routes-json" style="min-height:200px;font-family:var(--mono);font-size:11.5px">${h(formatJson(values.smart_routes))}</textarea></div>
              <div class="help">JSON 格式，groups 中的模型按顺序尝试；auto 会根据 Prompt 长度、代码特征与工具调用自动选择分组。</div>
            </div>
          </div>
          <div class="card">
            <div class="settings-section">
              <div class="settings-head"><div class="settings-icon">${ui.icon('lock', 16)}</div><div><div class="settings-title">企业 SSO 单点登录</div><div class="settings-desc">支持 OIDC、标准 OAuth2、飞书与钉钉扫码登录</div></div><button class="btn sm" id="add-sso" style="margin-left:auto">${ui.icon('plus', 14)} 添加提供方</button></div>
              <div id="sso-providers">
                ${providers.length ? providers.map((p, i) => providerCard(p, i)).join('') : ui.emptyState('尚未配置 SSO', '添加飞书、钉钉或标准 OIDC 提供方', 'shield')}
              </div>
              <div class="notice mt-12">${ui.icon('info', 16)} 飞书 / 钉钉使用其开放平台 OAuth 2.0；标准 OIDC 需填写 Issuer，系统将自动发现端点并校验 id_token 签名。</div>
            </div>
          </div>
        </div>
        <div class="stack">
          <div class="card">
            <div class="card-head"><div><div class="card-title">${ui.icon('database', 16)} 运行状态</div><div class="card-desc">进程与数据库</div></div><button class="icon-btn" id="refresh-system">${ui.icon('refresh', 15)}</button></div>
            <div class="card-body">
              <dl class="kv">
                <dt>网关版本</dt><dd>${h(system.version)}</dd>
                <dt>Node.js</dt><dd>${h(system.node)}</dd>
                <dt>运行时长</dt><dd>${ui.duration(system.uptime_seconds * 1000)}</dd>
                <dt>数据库</dt><dd>${(system.db_size_bytes / 1024 / 1024).toFixed(2)} MB</dd>
                <dt>内存 RSS</dt><dd>${(system.memory.rss / 1024 / 1024).toFixed(0)} MB</dd>
                <dt>当前并发</dt><dd>${ui.num(system.inflight)}</dd>
                <dt>断路器</dt><dd>${Object.entries(system.circuits).map(([k, v]) => `${h(k)}: ${v}`).join(' · ') || '—'}</dd>
                <dt>运行平台</dt><dd>${h(system.platform)}</dd>
              </dl>
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div><div class="card-title">${ui.icon('info', 16)} 配置提示</div><div class="card-desc">上线前检查项</div></div></div>
            <div class="card-body">
              <div class="plan-list">
                <div class="plan-row"><span class="plan-name">修改默认管理员密码</span><span class="plan-val">必须</span></div>
                <div class="plan-row"><span class="plan-name">配置 MASTER_SECRET</span><span class="plan-val">建议</span></div>
                <div class="plan-row"><span class="plan-name">启用企业 SSO</span><span class="plan-val">建议</span></div>
                <div class="plan-row"><span class="plan-name">配置告警 Webhook</span><span class="plan-val">建议</span></div>
                <div class="plan-row"><span class="plan-name">设置部门月度配额</span><span class="plan-val">建议</span></div>
              </div>
              <div class="notice mt-16">${ui.icon('shield', 16)} 上游 Master Key 与 SSO Client Secret 均以 AES-256-GCM 加密存储，界面不会回显完整密钥。</div>
            </div>
          </div>
        </div>
      </div>`;

    el.querySelector('#refresh-system').addEventListener('click', async () => {
      try { system = await api('/api/admin/system'); render(); ui.toast('系统状态已刷新', 'success'); } catch (err) { ui.toast(err.message, 'error'); }
    });
    el.querySelector('#add-sso').addEventListener('click', () => {
      const provider = { id: '', name: '', type: 'oidc', enabled: false, client_id: '', client_secret: '', issuer: '', scope: 'openid profile email', authorize_url: '', redirect_path: '' };
      providers.push(provider);
      render();
    });
    el.querySelectorAll('[data-remove-sso]').forEach((btn) => btn.addEventListener('click', async () => {
      if (!(await ui.confirmDialog({ title: '移除 SSO 提供方', message: '确定从配置中移除该单点登录提供方？', confirmText: '移除', danger: true }))) return;
      providers.splice(Number(btn.dataset.removeSso), 1);
      render();
    }));
    el.querySelector('#save-settings').addEventListener('click', async () => {
      const btn = el.querySelector('#save-settings');
      const updates = {};
      el.querySelectorAll('[data-setting]').forEach((input) => { updates[input.dataset.setting] = input.value; });
      let smartRoutes;
      try { smartRoutes = JSON.parse(el.querySelector('#smart-routes-json').value); } catch { ui.toast('smart_routes 不是合法 JSON', 'error'); return; }
      const ssoProviders = [...el.querySelectorAll('[data-sso-idx]')].map((card) => {
        const obj = {};
        card.querySelectorAll('[data-sso-field]').forEach((input) => {
          const field = input.dataset.ssoField;
          obj[field] = input.type === 'checkbox' ? input.checked : input.value.trim();
        });
        if (!obj.enabled && !obj.id && !obj.client_id) return null;
        obj.redirect_path = obj.redirect_path || (obj.id ? `/auth/sso/${obj.id}/callback` : '');
        if (!obj.redirect_path && obj.id) obj.redirect_path = `/auth/sso/${obj.id}/callback`;
        return obj;
      }).filter(Boolean);
      updates.smart_routes = smartRoutes;
      updates['sso.providers'] = ssoProviders;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 保存中…';
      try {
        await api('/api/admin/settings', { method: 'PUT', body: updates });
        if (updates['platform.name']) {
          ctx.state.config.platform_name = updates['platform.name'];
          const brand = document.querySelector('.brand-name');
          if (brand) brand.textContent = updates['platform.name'];
        }
        await load();
        ui.toast('设置已保存并生效', 'success');
      } catch (err) {
        ui.toast(err.message, 'error', 6000);
        btn.disabled = false;
        btn.innerHTML = `${ui.icon('check', 15)} 保存全部设置`;
      }
    });
  };

  await load();
}

function formatJson(value) {
  if (value === undefined || value === null) return '{}';
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

export const adminPages = {
  overview,
  channels,
  models,
  users,
  keys: adminKeys,
  logs,
  billing,
  audit,
  settings: settingsPage,
};
