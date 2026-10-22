import { api, streamSse } from '../api.js';
import * as ui from '../ui.js';

const h = ui.escapeHtml;

function pageHead(title, sub, actions = '') {
  return `<div class="page-head">
    <div><h1 class="page-title">${h(title)}</h1><p class="page-sub">${h(sub)}</p></div>
    <div class="page-actions">${actions}</div>
  </div>`;
}

function statCard({ label, value, iconName, tone, meta }) {
  return `<div class="card stat">
    <div class="stat-top"><div><div class="stat-label">${h(label)}</div><div class="stat-value">${value}</div></div><div class="stat-icon ${tone}">${ui.icon(iconName, 17)}</div></div>
    <div class="stat-meta"><div>${meta}</div></div>
  </div>`;
}

function quotaRows(scopes, currencyRate) {
  if (!scopes?.length) return ui.emptyState('暂无配额信息', '', 'wallet');
  return scopes.map((s) => {
    const unlimited = !s.limit || s.limit <= 0;
    const ratio = unlimited ? 0 : Math.min(1, (s.spent + (s.reserved || 0)) / s.limit);
    const pct = unlimited ? 0 : Math.min(100, ratio * 100);
    return `<div class="quota-card" style="padding:0 0 16px">
      <div class="quota-head"><span class="quota-name">${h(s.label)}</span><span class="quota-amount">${ui.usd(s.spent)} <span>/ ${unlimited ? '不限' : ui.usd(s.limit)}</span></span></div>
      <div class="progress ${pct >= 95 ? 'danger' : pct >= 85 ? 'warn' : ''}"><div style="width:${unlimited ? 100 : pct}%;${unlimited ? 'opacity:.28' : ''}"></div></div>
      <div class="quota-meta"><span>账期 ${h(s.period)}</span><span>${unlimited ? '无限额' : `剩余 ${ui.usd(Math.max(0, s.limit - s.spent))}`}${s.reserved > 0 ? ` · 处理中 ${ui.usd(s.reserved)}` : ''}</span></div>
    </div>`;
  }).join('');
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 19) return '下午好';
  return '晚上好';
}

function snippetTabs(base, key = 'sk-corp-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') {
  const snippets = {
    curl: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'`,
    python: `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${key}",
)

resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "你好"}],
)
print(resp.choices[0].message.content)`,
    node: `import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: '${base}',
  apiKey: '${key}',
});

const resp = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: '你好' }],
});
console.log(resp.choices[0].message.content);`,
    cursor: `# Cursor / IDE 配置
OPENAI_API_BASE=${base}
OPENAI_API_KEY=${key}

# 在 IDE 的 OpenAI 兼容配置中：
# Base URL: ${base}
# API Key:  ${key}
# Model:    gpt-4o / smart-coding / auto`,
    langchain: `from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="gpt-4o",
    base_url="${base}",
    api_key="${key}",
    streaming=True,
)
print(llm.invoke("你好").content)`,
  };
  return `<div class="quickstart-tabs" id="qs-tabs">${Object.keys(snippets).map((k, i) => `<button data-qs="${k}" class="${i === 0 ? 'active' : ''}">${k === 'node' ? 'Node.js' : k === 'cursor' ? 'Cursor' : k === 'langchain' ? 'LangChain' : k}</button>`).join('')}</div>
    <div id="qs-code">${Object.entries(snippets).map(([k, code], i) => `<div class="code-block" data-qs-panel="${k}" ${i ? 'style="display:none"' : ''}>${h(code)}<button class="btn sm copy-code" data-copy-code="${k}">${ui.icon('copy', 12)} 复制</button></div>`).join('')}</div>`;
}

function bindSnippets(container, base) {
  const tabs = container.querySelectorAll('[data-qs]');
  tabs.forEach((tab) => tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.toggle('active', t === tab));
    container.querySelectorAll('[data-qs-panel]').forEach((panel) => { panel.style.display = panel.dataset.qsPanel === tab.dataset.qs ? '' : 'none'; });
  }));
  container.querySelectorAll('[data-copy-code]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('[data-qs-panel]');
      const clone = panel.cloneNode(true);
      clone.querySelector('.copy-code')?.remove();
      ui.copyText(clone.textContent.trim());
    });
  });
}

/* ------------------------------------------------------------------ */
async function portalOverview(el, ctx) {
  const data = await api('/api/portal/overview');
  const p = data.platform;
  const month = data.month;
  const quota = data.quota?.scopes || [];
  const userQuota = quota.find((q) => q.type === 'user');
  const recent = data.recent_requests || [];
  const dailyPoints = data.daily.map((d) => ({ ts: new Date(`${d.day}T00:00:00`).getTime(), cost: d.cost, tokens: d.tokens, requests: d.requests }));

  el.innerHTML = `
    ${pageHead(`${greeting()}，${data.user.name}`, `欢迎来到 ${p.name} 开发者工作台 · ${data.user.org_name}`, `
      <button class="btn" id="go-playground">${ui.icon('terminal', 15)} 在线调试</button>
      <button class="btn primary" id="go-new-key">${ui.icon('plus', 15)} 创建 API Key</button>`)}
    <div class="card hero-card mb-16">
      <div class="hero-main">
        <h2>统一接入所有大模型</h2>
        <p>兼容 OpenAI SDK，只需替换 BaseURL 与 API Key。当前已接入 ${data.platform.name} 生产网关。</p>
        <div class="flex gap-12 mt-16" style="flex-wrap:wrap">
          <span class="chip">${ui.icon('code', 13)} OpenAI 协议 100% 兼容</span>
          <span class="chip">${ui.icon('route', 13)} 跨厂商自动 Fallback</span>
          <span class="chip">${ui.icon('shield', 13)} 密钥加密与审计</span>
        </div>
      </div>
      <div class="hero-actions">
        <div class="code-block" style="padding:9px 12px;font-size:11px;min-width:270px">${h(p.base_url)}</div>
      </div>
    </div>
    <div class="grid grid-4 mb-16">
      ${statCard({ label: '本月消费', value: ui.usd(month.cost_usd), iconName: 'wallet', tone: 'green', meta: `≈ ${ui.cny(month.cost_usd, p.currency_rate)} · 今日 ${ui.usd(data.today.cost_usd)}` })}
      ${statCard({ label: '本月请求', value: ui.num(month.requests), iconName: 'activity', tone: 'violet', meta: `今日 ${ui.num(data.today.requests)} 次调用` })}
      ${statCard({ label: '本月 Tokens', value: ui.compact(month.total_tokens), iconName: 'zap', tone: 'cyan', meta: `输入 ${ui.compact(month.prompt_tokens)} / 输出 ${ui.compact(month.completion_tokens)}` })}
      ${statCard({ label: '活跃 API Key', value: ui.num(data.active_keys), iconName: 'key', tone: 'amber', meta: userQuota?.limit ? `个人额度已用 ${((userQuota.spent / userQuota.limit) * 100).toFixed(1)}%` : '点击右侧管理密钥' })}
    </div>
    <div class="grid grid-2-1 mb-16">
      <div class="card">
        <div class="card-head"><div><div class="card-title">${ui.icon('code', 16)} 快速接入</div><div class="card-desc">选择你常用的工具，复制示例代码开始调用</div></div><span class="badge green">BaseURL 已就绪</span></div>
        <div class="card-body" id="quickstart">${snippetTabs(p.base_url)}
          <div class="notice mt-12">${ui.icon('info', 16)} 统一 BaseURL 已就绪。前往「我的 API Key」创建密钥后，替换示例中的占位 Key 即可开始调用。</div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">${ui.icon('gauge', 16)} 我的额度</div><div class="card-desc">账期 ${h(data.quota.period)} · 多级配额实时扣减</div></div></div>
        <div class="card-body">
          ${quotaRows(quota, p.currency_rate)}
          <div class="notice mt-16">${ui.icon('info', 16)} 个人与部门额度同时生效，任一额度耗尽即触发 429 熔断。PROD 标签的 Key 可申请透支白名单。</div>
        </div>
      </div>
    </div>
    <div class="grid grid-2-1">
      <div class="card">
        <div class="card-head"><div><div class="card-title">${ui.icon('bar-chart', 16)} 近 30 天消费</div><div class="card-desc">每日成本（USD）</div></div></div>
        <div class="card-body" id="portal-usage-chart"></div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">${ui.icon('clock', 16)} 最近请求</div><div class="card-desc">仅展示元数据</div></div><a class="btn ghost sm" href="/portal#/usage">全部</a></div>
        <div class="card-body" style="padding-top:10px">
          ${recent.length ? `<div class="recent-list">${recent.map((r) => `<div class="recent-row"><span class="dot ${r.status === 'success' ? 'green' : r.status === 'cancelled' ? 'amber' : 'red'}"></span><span class="r-model mono">${h(r.model)}</span><span class="r-meta">${ui.duration(r.latency_ms)} · ${ui.compact(r.total_tokens)} tok · ${ui.usd(r.cost_usd)}</span><span class="muted-2 text-xs" style="width:58px;text-align:right">${ui.timeAgo(r.ts)}</span></div>`).join('')}</div>` : ui.emptyState('还没有调用记录', '创建 Key 后即可开始调试', 'activity')}
        </div>
      </div>
    </div>`;

  const qs = el.querySelector('#quickstart');
  bindSnippets(qs, p.base_url);
  el.querySelector('#go-playground').addEventListener('click', () => ctx.navigate('portal', 'playground'));
  el.querySelector('#go-new-key').addEventListener('click', () => ctx.navigate('portal', 'keys'));
  ui.areaChart(el.querySelector('#portal-usage-chart'), {
    points: dailyPoints, value: 'cost', color: '#34d399', label: '消费',
    format: (v) => ui.usd(v), xFormat: (ts) => ui.fmtDate(ts, false).slice(5),
  });
}

/* ------------------------------------------------------------------ */
async function portalKeys(el, ctx) {
  let data = { items: [] };
  let models = [];
  const load = async () => {
    const [k, m] = await Promise.all([api('/api/portal/keys'), api('/api/portal/models')]);
    data = k;
    models = m.data;
    render();
  };

  const reveal = (plaintext) => {
    ui.openModal({
      title: 'API Key 创建成功',
      size: 'narrow',
      body: `<div class="notice warn mb-16">${ui.icon('alert', 16)} 这是唯一一次展示完整密钥。关闭后将无法再次查看，请立即复制并妥善保存。</div>
        <div class="one-time-key"><code>${h(plaintext)}</code><button class="btn sm" id="copy-plain">${ui.icon('copy', 13)} 复制</button></div>
        <div class="help mt-12">如果泄露，请立即在列表中停用或删除该 Key。</div>`,
      footer: '<button class="btn primary" data-close>我已保存</button>',
      onMount(modalEl) { modalEl.querySelector('#copy-plain').addEventListener('click', () => ui.copyText(plaintext)); },
    });
  };

  const openCreate = () => {
    ui.openModal({
      title: '创建 API Key',
      subtitle: 'Key 采用 sk-corp- 前缀，数据库仅存储哈希与掩码',
      body: `<form id="create-key-form">
        <div class="form-grid">
          <div class="field span-2"><label>Key 名称 <span class="req">*</span></label><input name="name" placeholder="例如：Cursor-Local-Dev" /><div class="help">用于区分不同应用场景，例如 IDE、生产服务、批处理任务。</div></div>
          <div class="field"><label>过期时间</label><input name="expires_at" type="date" /><div class="help">留空表示永久有效</div></div>
          <div class="field"><label>月度限额（USD）</label><input name="monthly_limit_usd" type="number" min="0" step="0.01" placeholder="0 = 不限" /></div>
          <div class="field"><label>总额度（USD）</label><input name="total_limit_usd" type="number" min="0" step="0.01" placeholder="0 = 不限" /></div>
          <div class="field"><label>QPS 上限</label><input name="qps_limit" type="number" min="1" placeholder="留空使用默认值" /></div>
          <div class="field"><label>TPM 上限</label><input name="tpm_limit" type="number" min="1" placeholder="留空使用默认值" /></div>
          <div class="field span-2"><label>授权模型白名单</label>
            <div class="checkbox-grid" style="max-height:170px;overflow:auto;padding:4px 0">${models.map((m) => `<label class="checkline"><input type="checkbox" class="allowed-model" value="${h(m.id)}"/> ${h(m.name)} <span class="mono text-xs muted-2">${h(m.id)}</span></label>`).join('')}</div>
            <div class="help">不勾选表示允许访问全部已开放模型。</div>
          </div>
          <div class="field span-2"><label>IP CIDR 白名单</label><textarea name="ip_whitelist" placeholder="10.0.0.0/8&#10;203.0.113.5"></textarea><div class="help">每行一个 IP 或 CIDR，留空表示不限制来源 IP。</div></div>
        </div>
      </form>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn primary" id="create-key-btn">${ui.icon('key', 15)} 创建 Key</button>`,
      onMount(modalEl, close) {
        const form = modalEl.querySelector('#create-key-form');
        modalEl.querySelector('#create-key-btn').addEventListener('click', async () => {
          const name = form.name.value.trim();
          if (!name) { ui.toast('请填写 Key 名称', 'error'); return; }
          const btn = modalEl.querySelector('#create-key-btn');
          btn.disabled = true;
          const expires = form.expires_at.value ? new Date(`${form.expires_at.value}T23:59:59`).getTime() : null;
          const allowed = [...modalEl.querySelectorAll('.allowed-model:checked')].map((x) => x.value);
          try {
            const result = await api('/api/portal/keys', {
              method: 'POST',
              body: {
                name,
                expires_at: expires,
                monthly_limit_usd: Number(form.monthly_limit_usd.value) || 0,
                total_limit_usd: Number(form.total_limit_usd.value) || 0,
                qps_limit: form.qps_limit.value ? Number(form.qps_limit.value) : null,
                tpm_limit: form.tpm_limit.value ? Number(form.tpm_limit.value) : null,
                allowed_models: allowed,
                ip_whitelist: form.ip_whitelist.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
              },
            });
            close();
            await load();
            reveal(result.plaintext);
          } catch (err) {
            ui.toast(err.message, 'error', 5000);
            btn.disabled = false;
          }
        });
      },
    });
  };

  const render = () => {
    el.innerHTML = `
      ${pageHead('我的 API Key', '自助签发、限额配置与密钥生命周期管理。每个 Key 独立计量并计入个人 / 部门配额', `<button class="btn primary" id="new-key">${ui.icon('plus', 15)} 新建 API Key</button>`)}
      ${data.items.length ? `<div class="key-card-grid">
        ${data.items.map((k) => {
          const limit = Number(k.monthly_limit_usd) || 0;
          const spent = Number(k.month_spent_usd) || 0;
          const pct = limit > 0 ? Math.min(100, (spent / limit) * 100) : 0;
          return `<div class="card key-card">
            <div class="key-card-head">
              <div class="key-icon">${ui.icon('key', 16)}</div>
              <div style="flex:1;min-width:0"><div class="key-name">${h(k.name)} ${(k.tags || []).map((t) => ui.tag(t)).join(' ')}</div><div class="key-mask">${h(k.masked)}</div></div>
              <label class="switch sm ${k.status === 'active' ? 'on' : ''} ${k.status === 'revoked' ? 'disabled' : ''}" data-key-toggle="${k.id}" title="${k.status === 'active' ? '停用' : '启用'}"></label>
            </div>
            <div class="key-limits">
              <div>本月消费<br/><b>${ui.usd(spent)} ${limit ? `/ ${ui.usd(limit)}` : ''}</b>${Number(k.total_limit_usd) > 0 ? `<div class="text-xs muted-2">累计 ${ui.usd(k.total_spent_usd)} / ${ui.usd(k.total_limit_usd)}</div>` : ''}</div>
              <div>速率限制<br/><b>${k.qps_limit || '默认'} QPS · ${k.tpm_limit ? ui.compact(k.tpm_limit) : '默认'} TPM</b></div>
              <div>授权模型<br/><b>${k.allowed_models?.length ? `${k.allowed_models.length} 个` : '全部模型'}</b></div>
              <div>最近使用<br/><b>${k.last_request_at ? ui.timeAgo(k.last_request_at) : '从未'}</b></div>
            </div>
            ${limit ? `<div class="progress ${pct >= 95 ? 'danger' : pct >= 85 ? 'warn' : ''}"><div style="width:${pct}%"></div></div>` : ''}
            <div class="key-card-foot">
              <span class="badge ${k.status === 'active' ? 'green' : k.status === 'disabled' ? 'gray' : 'red'}">${k.status === 'active' ? '使用中' : k.status === 'disabled' ? '已停用' : '已吊销'}</span>
              <span class="muted-2 text-xs">创建于 ${ui.fmtDate(k.created_at, false)}</span>
              <div style="flex:1"></div>
              ${k.status !== 'revoked' ? `<button class="btn sm danger" data-key-del="${k.id}">${ui.icon('trash', 13)} 删除</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>` : `<div class="card"><div class="empty" style="padding:64px 20px">${ui.icon('key', 40)}<div class="empty-title">还没有 API Key</div><div>创建一个专属 Key，即可通过 OpenAI SDK 接入网关</div><button class="btn primary mt-12" id="empty-new-key">${ui.icon('plus', 15)} 创建第一个 Key</button></div></div>`}`;
    el.querySelector('#new-key')?.addEventListener('click', openCreate);
    el.querySelector('#empty-new-key')?.addEventListener('click', openCreate);
    el.querySelectorAll('[data-key-toggle]').forEach((sw) => {
      sw.addEventListener('click', async () => {
        if (sw.classList.contains('disabled')) return;
        const key = data.items.find((k) => k.id === sw.dataset.keyToggle);
        const next = key.status === 'active' ? 'disabled' : 'active';
        try {
          await api(`/api/portal/keys/${key.id}`, { method: 'PATCH', body: { status: next } });
          ui.toast(next === 'active' ? 'Key 已启用' : 'Key 已停用', 'success');
          await load();
        } catch (err) { ui.toast(err.message, 'error'); }
      });
    });
    el.querySelectorAll('[data-key-del]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = data.items.find((k) => k.id === btn.dataset.keyDel);
        if (!(await ui.confirmDialog({ title: '删除 API Key', message: `确定删除「${key.name}」？此操作不可恢复，使用该 Key 的请求会立即失败。`, confirmText: '确认删除', danger: true }))) return;
        try {
          await api(`/api/portal/keys/${key.id}`, { method: 'DELETE' });
          ui.toast('Key 已删除', 'success');
          await load();
        } catch (err) { ui.toast(err.message, 'error'); }
      });
    });
  };
  await load();
}

/* ------------------------------------------------------------------ */
async function portalModels(el, ctx) {
  const res = await api('/api/portal/models');
  const models = res.data || [];
  let filter = 'all';
  let q = '';

  const render = () => {
    const list = models.filter((m) => (filter === 'all' || m.capabilities.includes(filter)) && (!q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)));
    el.innerHTML = `
      ${pageHead('模型广场', '平台已开放的模型与价格目录。所有模型均通过统一 OpenAI 协议访问', `<span class="env-pill">${ui.icon('layers', 13)} ${models.length} 个模型</span>`)}
      <div class="card mb-16">
        <div class="table-toolbar">
          <div class="field grow"><div class="input-icon">${ui.icon('search', 15)}<input class="search-input" id="model-search" value="${h(q)}" placeholder="搜索模型名称或别名" /></div></div>
          <div class="seg" id="model-filter">
            ${[['all', '全部'], ['chat', '对话'], ['vision', '视觉'], ['tools', '工具'], ['reasoning', '推理'], ['embedding', '向量']].map(([v, l]) => `<button data-filter="${v}" class="${filter === v ? 'active' : ''}">${l}</button>`).join('')}
          </div>
        </div>
      </div>
      <div class="model-grid">
        ${list.map((m) => `<div class="card model-card">
          <div class="model-card-head">
            <div class="model-avatar" style="background:${m.kind === 'router' ? 'linear-gradient(135deg,#22d3ee,#8b5cf6)' : 'linear-gradient(135deg,#8b5cf6,#f472b6)'}">${h(m.id.slice(0, 2).toUpperCase())}</div>
            <div style="flex:1;min-width:0"><div class="model-name">${h(m.name)}</div><div class="model-id">${h(m.id)}</div></div>
            ${m.available ? '<span class="badge green"><span class="dot green"></span> 可用</span>' : '<span class="badge gray">维护中</span>'}
          </div>
          <div class="model-desc">${h(m.description || '统一接入的企业级模型')}</div>
          <div class="cap-list">${(m.capabilities || []).map((c) => `<span class="cap">${h(ui.capabilityLabel(c))}</span>`).join('')}</div>
          <div class="model-specs">
            <div class="model-spec"><span>上下文窗口</span><b>${m.context_window ? ui.compact(m.context_window) : '—'}</b></div>
            <div class="model-spec"><span>最大输出</span><b>${m.max_output_tokens ? ui.compact(m.max_output_tokens) : '—'}</b></div>
            <div class="model-spec"><span>输入价格 / 1M</span><b>${m.kind === 'router' ? '自动选择' : ui.usd(m.pricing.input_per_1k * 1000)}</b></div>
            <div class="model-spec"><span>输出价格 / 1M</span><b>${m.kind === 'router' ? '自动选择' : ui.usd(m.pricing.output_per_1k * 1000)}</b></div>
          </div>
          <div class="model-foot">
            <span class="cell-sub">${m.kind === 'router' ? '智能路由' : `${m.channel_count} 个渠道`} · ${ui.badge(m.kind === 'router' ? 'Router' : 'Model', m.kind === 'router' ? 'violet' : 'gray')}</span>
            <button class="btn sm primary" data-play="${h(m.id)}">${ui.icon('play', 12)} 调试</button>
          </div>
        </div>`).join('') || `<div class="card" style="grid-column:1/-1">${ui.emptyState('没有匹配的模型', '调整筛选条件或联系管理员开通权限', 'layers')}</div>`}
      </div>`;
    el.querySelector('#model-search').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); render(); setTimeout(() => { const input = el.querySelector('#model-search'); input.focus(); input.setSelectionRange(q.length, q.length); }, 0); });
    el.querySelectorAll('#model-filter [data-filter]').forEach((btn) => btn.addEventListener('click', () => { filter = btn.dataset.filter; render(); }));
    el.querySelectorAll('[data-play]').forEach((btn) => btn.addEventListener('click', () => {
      sessionStorage.setItem('gateway.playground.model', btn.dataset.play);
      ctx.navigate('portal', 'playground');
    }));
  };
  render();
}

/* ------------------------------------------------------------------ */
function formatChatContent(text) {
  const raw = String(text || '');
  const parts = raw.split(/```/);
  return parts.map((part, idx) => {
    if (idx % 2 === 1) {
      const firstLine = part.indexOf('\n');
      const code = firstLine >= 0 ? part.slice(firstLine + 1) : part;
      return `<pre>${h(code.replace(/\n$/, ''))}</pre>`;
    }
    return h(part);
  }).join('');
}

function messageHtml(msg, userInitials) {
  const isUser = msg.role === 'user';
  return `<div class="msg ${isUser ? 'user' : 'assistant'}" data-msg="${msg.id}">
    <div class="msg-avatar">${isUser ? h(userInitials) : ui.icon('sparkles', 14)}</div>
    <div>
      <div class="msg-bubble ${msg.error ? 'msg-error' : ''}">${isUser ? h(msg.content) : formatChatContent(msg.content)}${!isUser && msg.reasoning ? `<details class="reasoning-block"><summary>查看思考过程</summary><pre>${h(msg.reasoning)}</pre></details>` : ''}${msg.loading && !msg.content ? '<div class="typing"><i></i><i></i><i></i></div>' : ''}</div>
      ${msg.meta ? `<div class="msg-meta">${msg.meta}</div>` : ''}
    </div>
  </div>`;
}

async function playground(el, ctx) {
  const modelsRes = await api('/api/portal/models');
  const models = modelsRes.data || [];
  if (!models.length) {
    el.innerHTML = `${pageHead('在线调试', '浏览器内直接验证模型链路')}<div class="notice warn">${ui.icon('alert', 16)} 当前没有可用模型，请联系管理员配置渠道与模型映射。</div>`;
    return;
  }
  const savedModel = sessionStorage.getItem('gateway.playground.model');
  let currentModel = models.find((m) => m.id === savedModel)?.id || models[0].id;
  let conversation = [];
  let running = false;
  let abortController = null;
  let systemPrompt = '';
  let temperature = 0.7;
  let maxTokens = 1024;
  let streamMode = true;
  let lastUsage = null;
  const userInitials = ui.initials(ctx.state.user.name);

  el.innerHTML = `
    ${pageHead('在线调试', '即时验证模型、流式响应与用量计费。调试调用计入个人 / 部门配额，但不占用 API Key 限额', `<button class="btn" id="clear-chat">${ui.icon('trash', 15)} 清空对话</button>`)}
    <div class="playground-layout">
      <div class="card playground-side">
        <div class="field"><label>选择模型</label><select id="pg-model">${models.map((m) => `<option value="${h(m.id)}" ${m.id === currentModel ? 'selected' : ''}>${h(m.name)} · ${h(m.id)}</option>`).join('')}</select></div>
        <div class="notice" id="pg-model-info"></div>
        <div class="field"><label>System Prompt</label><textarea id="pg-system" placeholder="可选：设定模型角色与回答风格" style="min-height:80px"></textarea></div>
        <div class="field"><label>Temperature <span class="mono" id="pg-temp-val" style="margin-left:auto;color:var(--muted-2)">0.7</span></label><input id="pg-temp" type="range" min="0" max="2" step="0.1" value="0.7" style="width:100%;accent-color:#8b5cf6" /></div>
        <div class="field"><label>最大输出 Tokens</label><input id="pg-max-tokens" type="number" min="1" max="32768" value="1024" /></div>
        <label class="checkline"><span id="pg-stream-switch" class="switch on"></span> 流式输出（SSE）</label>
        <div class="notice">${ui.icon('info', 16)} 调试台使用会话身份直接调用网关，仍会经过配额校验、速率限制与路由 / 熔断策略。</div>
      </div>
      <div class="card playground-main">
        <div class="playground-head">
          <span class="dot green"></span>
          <b id="pg-head-model" style="font-size:12.5px"></b>
          <span class="muted-2 text-xs" id="pg-head-meta"></span>
          <div style="flex:1"></div>
          <span class="badge cyan">Playground</span>
        </div>
        <div class="playground-messages" id="pg-messages"></div>
        <div class="playground-compose">
          <div class="compose-box">
            <textarea id="pg-input" placeholder="输入消息，Enter 发送，Shift + Enter 换行…" rows="1"></textarea>
            <button class="compose-send" id="pg-send" title="发送">${ui.icon('send', 16)}</button>
          </div>
          <div class="compose-hint"><span>模型输出可能不准确，请自行验证关键结论</span><span id="pg-hint">${streamMode ? 'SSE 流式' : '非流式'}</span></div>
        </div>
        <div class="usage-strip" id="pg-usage">
          <span>Tokens <b id="u-total">0</b></span><span>输入 <b id="u-prompt">0</b></span><span>输出 <b id="u-completion">0</b></span><span>预估费用 <b id="u-cost">$0.00</b></span><span id="u-extra"></span>
        </div>
      </div>
    </div>`;

  const modelSel = el.querySelector('#pg-model');
  const streamSwitch = el.querySelector('#pg-stream-switch');
  const messagesEl = el.querySelector('#pg-messages');
  const inputEl = el.querySelector('#pg-input');
  const sendBtn = el.querySelector('#pg-send');
  const usageEls = {
    total: el.querySelector('#u-total'), prompt: el.querySelector('#u-prompt'),
    completion: el.querySelector('#u-completion'), cost: el.querySelector('#u-cost'), extra: el.querySelector('#u-extra'),
  };

  const modelInfo = () => models.find((m) => m.id === currentModel) || models[0];
  const updateModelInfo = () => {
    const m = modelInfo();
    el.querySelector('#pg-head-model').textContent = m.name;
    el.querySelector('#pg-head-meta').textContent = `${m.id} · 上下文 ${ui.compact(m.context_window || 0)} · ${m.available ? '可用' : '维护中'}`;
    const info = el.querySelector('#pg-model-info');
    info.innerHTML = `<div style="display:grid;grid-template-columns:auto 1fr;gap:5px 10px;font-size:10.5px;line-height:1.5">
      <span class="muted-2">输入 / 1M</span><span class="mono" style="text-align:right;color:var(--text-soft)">${m.kind === 'router' ? 'Auto' : ui.usd(m.pricing.input_per_1k * 1000)}</span>
      <span class="muted-2">输出 / 1M</span><span class="mono" style="text-align:right;color:var(--text-soft)">${m.kind === 'router' ? 'Auto' : ui.usd(m.pricing.output_per_1k * 1000)}</span>
      <span class="muted-2">能力</span><span style="text-align:right;color:var(--text-soft)">${m.capabilities.map(ui.capabilityLabel).join(' · ')}</span>
    </div>`;
  };
  updateModelInfo();

  const updateUsage = (usage) => {
    lastUsage = usage || lastUsage;
    if (!lastUsage) return;
    const m = modelInfo();
    const p = Number(lastUsage.prompt_tokens) || 0;
    const c = Number(lastUsage.completion_tokens) || 0;
    const total = Number(lastUsage.total_tokens) || p + c;
    usageEls.prompt.textContent = ui.num(p);
    usageEls.completion.textContent = ui.num(c);
    usageEls.total.textContent = ui.num(total);
    const cost = m.kind === 'router' ? 0 : (p / 1000) * m.pricing.input_per_1k + (c / 1000) * m.pricing.output_per_1k;
    usageEls.cost.textContent = ui.usd(cost);
    usageEls.extra.textContent = lastUsage.estimated ? '· 含本地估算' : '';
  };

  const scrollBottom = () => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const syncChat = () => {
    if (!conversation.length) {
      messagesEl.innerHTML = `<div class="playground-empty">
        <div class="pe-icon">${ui.icon('sparkles', 24)}</div>
        <h3>开始你的第一次调试</h3>
        <p>选择左侧模型，输入问题即可实时查看 SSE 流式输出与 Token 计费。也可以试试下面的示例：</p>
        <div class="example-prompts">
          <button class="example-prompt" data-example="用三句话解释什么是 LLM API Gateway。">用三句话解释什么是 LLM API Gateway。</button>
          <button class="example-prompt" data-example="请写一个带超时和重试的 Node.js fetch 封装。">请写一个带超时和重试的 Node.js fetch 封装。</button>
          <button class="example-prompt" data-example="比较一下 GPT-4o 和 Claude 3.5 Sonnet 的适用场景。">比较一下 GPT-4o 和 Claude 3.5 Sonnet 的适用场景。</button>
        </div>
      </div>`;
      messagesEl.querySelectorAll('[data-example]').forEach((btn) => btn.addEventListener('click', () => {
        inputEl.value = btn.dataset.example;
        autoResize();
        send();
      }));
      return;
    }
    messagesEl.innerHTML = conversation.map((m) => messageHtml(m, userInitials)).join('');
    scrollBottom();
  };

  const autoResize = () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(150, inputEl.scrollHeight)}px`;
  };

  const setRunning = (value) => {
    running = value;
    sendBtn.innerHTML = value ? ui.icon('stop', 15) : ui.icon('send', 16);
    sendBtn.title = value ? '停止生成' : '发送';
    inputEl.disabled = false;
  };

  const updateAssistant = (msg) => {
    const node = messagesEl.querySelector(`[data-msg="${msg.id}"]`);
    if (!node) return;
    const bubble = node.querySelector('.msg-bubble');
    bubble.classList.toggle('msg-error', !!msg.error);
    bubble.innerHTML = `${formatChatContent(msg.content)}${msg.reasoning ? `<details class="reasoning-block"><summary>查看思考过程</summary><pre>${h(msg.reasoning)}</pre></details>` : ''}${msg.loading ? '<div class="typing"><i></i><i></i><i></i></div>' : ''}`;
    let meta = node.querySelector('.msg-meta');
    if (msg.meta) {
      if (!meta) { meta = document.createElement('div'); meta.className = 'msg-meta'; node.querySelector('.msg-bubble').after(meta); }
      meta.innerHTML = msg.meta;
    }
    scrollBottom();
  };

  let msgSeq = 0;
  const send = async () => {
    if (running) {
      abortController?.abort();
      return;
    }
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    autoResize();
    const userMsg = { id: `m${++msgSeq}`, role: 'user', content: text };
    const assistant = { id: `m${++msgSeq}`, role: 'assistant', content: '', reasoning: '', loading: true, meta: '' };
    conversation.push(userMsg, assistant);
    syncChat();
    setRunning(true);
    lastUsage = null;
    ['total', 'prompt', 'completion'].forEach((k) => { usageEls[k].textContent = '0'; });
    usageEls.cost.textContent = '$0.00';
    usageEls.extra.textContent = '';

    const bodyMessages = [];
    if (systemPrompt.trim()) bodyMessages.push({ role: 'system', content: systemPrompt.trim() });
    for (const m of conversation) {
      if (m.role === 'user' || (m.role === 'assistant' && m.content && !m.loading)) bodyMessages.push({ role: m.role, content: m.content });
    }
    const payload = {
      model: currentModel,
      messages: bodyMessages,
      stream: streamMode,
      temperature,
      max_tokens: maxTokens,
    };
    abortController = new AbortController();
    const started = performance.now();
    try {
      if (streamMode) {
        await streamSse('/api/portal/playground', payload, {
          signal: abortController.signal,
          onJson(chunk) {
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.reasoning_content) assistant.reasoning += delta.reasoning_content;
            if (delta?.content) assistant.content += delta.content;
            if (chunk.usage) updateUsage(chunk.usage);
            updateAssistant(assistant);
          },
        });
        assistant.loading = false;
        assistant.meta = `${ui.duration(performance.now() - started)} · ${currentModel}`;
        updateAssistant(assistant);
      } else {
        const res = await api('/api/portal/playground', { method: 'POST', body: payload, signal: abortController.signal });
        assistant.content = res.choices?.[0]?.message?.content || '';
        updateUsage(res.usage);
        assistant.loading = false;
        assistant.meta = `${ui.duration(performance.now() - started)} · ${currentModel}`;
        updateAssistant(assistant);
      }
    } catch (err) {
      assistant.loading = false;
      if (err.name === 'AbortError') {
        assistant.content = assistant.content || '（已停止生成）';
        assistant.meta = '已手动停止';
        updateAssistant(assistant);
      } else {
        assistant.error = true;
        assistant.content = assistant.content || `请求失败：${err.message}`;
        assistant.meta = `HTTP ${err.status || '—'} · ${err.code || 'error'}`;
        updateAssistant(assistant);
        ui.toast(err.message, 'error', 5000);
      }
    } finally {
      setRunning(false);
      abortController = null;
      const textarea = el.querySelector('#pg-input');
      textarea?.focus();
    }
  };

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.addEventListener('input', autoResize);
  el.querySelector('#pg-system').addEventListener('input', (e) => { systemPrompt = e.target.value; });
  el.querySelector('#pg-max-tokens').addEventListener('change', (e) => { maxTokens = Math.max(1, Math.min(32768, Number(e.target.value) || 1024)); e.target.value = maxTokens; });
  el.querySelector('#pg-temp').addEventListener('input', (e) => {
    temperature = Number(e.target.value);
    el.querySelector('#pg-temp-val').textContent = temperature.toFixed(1);
  });
  streamSwitch.addEventListener('click', () => {
    streamMode = !streamMode;
    streamSwitch.classList.toggle('on', streamMode);
    el.querySelector('#pg-hint').textContent = streamMode ? 'SSE 流式' : '非流式';
  });
  modelSel.addEventListener('change', () => {
    currentModel = modelSel.value;
    sessionStorage.setItem('gateway.playground.model', currentModel);
    updateModelInfo();
    lastUsage = null;
    usageEls.extra.textContent = '';
    ['total', 'prompt', 'completion'].forEach((k) => { usageEls[k].textContent = '0'; });
    usageEls.cost.textContent = '$0.00';
  });
  el.querySelector('#clear-chat').addEventListener('click', () => {
    if (running) abortController?.abort();
    conversation = [];
    syncChat();
    lastUsage = null;
    ['total', 'prompt', 'completion'].forEach((k) => { usageEls[k].textContent = '0'; });
    usageEls.cost.textContent = '$0.00';
    usageEls.extra.textContent = '';
  });
  syncChat();
  autoResize();
  inputEl.focus();
  return () => { abortController?.abort(); };
}

/* ------------------------------------------------------------------ */
async function portalUsage(el, ctx) {
  let usage = null;
  let logsData = { items: [], total: 0, page: 1, pages: 1 };
  let page = 1;
  let status = '';

  const load = async () => {
    const p = new URLSearchParams({ page, page_size: '15', from: String(Date.now() - 30 * 86400000) });
    if (status) p.set('status', status);
    const [u, l] = await Promise.all([api('/api/portal/usage?days=30'), api(`/api/portal/logs?${p}`)]);
    usage = u;
    logsData = l;
    render();
  };

  const render = () => {
    const quota = usage.quota || [];
    const dailyPoints = usage.daily.map((d) => ({ ts: new Date(`${d.day}T00:00:00`).getTime(), cost: d.cost, requests: d.requests, tokens: d.tokens }));
    const maxModelCost = Math.max(0.000001, ...usage.by_model.map((m) => Number(m.cost) || 0));
    el.innerHTML = `
      ${pageHead('用量与账单', '近 30 天个人 Token 消耗、成本分布与请求明细', `<span class="env-pill">${ui.icon('clock', 13)} 数据保留 30 天</span>`)}
      <div class="grid grid-4 mb-16">
        ${statCard({ label: '请求总数', value: ui.num(usage.totals.requests), iconName: 'activity', tone: 'violet', meta: '近 30 天' })}
        ${statCard({ label: '输入 Tokens', value: ui.compact(usage.totals.prompt_tokens), iconName: 'download', tone: 'cyan', meta: 'Prompt / 上下文' })}
        ${statCard({ label: '输出 Tokens', value: ui.compact(usage.totals.completion_tokens), iconName: 'zap', tone: 'amber', meta: 'Completion' })}
        ${statCard({ label: '总成本', value: ui.usd(usage.totals.cost_usd), iconName: 'wallet', tone: 'green', meta: `总 Tokens ${ui.compact(usage.totals.total_tokens)}` })}
      </div>
      <div class="grid grid-2-1 mb-16">
        <div class="card">
          <div class="card-head"><div><div class="card-title">${ui.icon('bar-chart', 16)} 每日消费趋势</div><div class="card-desc">近 30 天成本（USD）</div></div></div>
          <div class="card-body" id="usage-chart"></div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="card-title">${ui.icon('gauge', 16)} 当前额度</div><div class="card-desc">账期实时扣减</div></div></div>
          <div class="card-body">${quotaRows(quota)}</div>
        </div>
      </div>
      <div class="grid grid-2-1 mb-16">
        <div class="card">
          <div class="card-head"><div><div class="card-title">${ui.icon('layers', 16)} 模型消费分布</div><div class="card-desc">近 30 天</div></div></div>
          <div class="card-body">
            ${usage.by_model.length ? `<div class="bar-list">${usage.by_model.map((m) => `<div class="bar-item"><div class="bar-top"><div class="bar-label"><span class="mono" style="font-size:11.5px">${h(m.model)}</span><span class="muted-2 text-xs">${ui.num(m.requests)} 次</span></div><span class="mono text-xs">${ui.usd(m.cost)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (m.cost / maxModelCost) * 100)}%"></div></div></div>`).join('')}</div>` : ui.emptyState('暂无模型调用', '', 'layers')}
          </div>
        </div>
        <div class="card">
          <div class="card-head"><div><div class="card-title">${ui.icon('info', 16)} 计费说明</div><div class="card-desc">透明、可核对</div></div></div>
          <div class="card-body">
            <div class="plan-list">
              <div class="plan-row"><span class="plan-name">计费单位</span><span class="plan-val">每 1K Tokens</span></div>
              <div class="plan-row"><span class="plan-name">输入 / 输出</span><span class="plan-val">分别计价</span></div>
              <div class="plan-row"><span class="plan-name">成本口径</span><span class="plan-val">上游 usage</span></div>
              <div class="plan-row"><span class="plan-name">缺失兜底</span><span class="plan-val">本地分词估算</span></div>
            </div>
            <div class="notice mt-16">${ui.icon('shield', 16)} 网关仅存储请求元数据（模型、Tokens、耗时、状态码），不保存对话内容。</div>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="table-toolbar">
          <div><div class="section-title">请求明细</div><div class="section-sub">近 30 天，共 ${ui.num(logsData.total)} 条</div></div>
          <div class="spacer"></div>
          <div class="seg" id="usage-status">
            ${[['', '全部'], ['success', '成功'], ['error', '失败'], ['cancelled', '取消']].map(([v, l]) => `<button data-status="${v}" class="${status === v ? 'active' : ''}">${l}</button>`).join('')}
          </div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead><tr><th>时间</th><th>模型</th><th>来源</th><th>状态</th><th class="num">延迟</th><th class="num">Tokens</th><th class="num">成本</th></tr></thead>
            <tbody>
              ${logsData.items.map((r) => `<tr><td class="mono" style="font-size:11px">${ui.fmtDate(r.ts)}</td><td class="mono" style="font-size:11.5px">${h(r.model)}</td><td>${r.source === 'playground' ? ui.badge('调试台', 'cyan') : ui.badge('API', 'gray')}</td><td>${ui.statusBadge(r.status, r.http_status)}</td><td class="num">${ui.duration(r.latency_ms)}</td><td class="num">${ui.compact(r.total_tokens)}</td><td class="num">${ui.usd(r.cost_usd)}</td></tr>`).join('') || `<tr><td colspan="7">${ui.emptyState('暂无请求记录', '', 'activity')}</td></tr>`}
            </tbody>
          </table>
        </div>
        ${(() => { const p = ui.paginationHtml({ page: logsData.page, pages: logsData.pages, total: logsData.total }); return `<div class="table-foot"><div>${p.meta}</div><div class="pagination">${p.buttons}</div></div>`; })()}
      </div>`;
    ui.areaChart(el.querySelector('#usage-chart'), {
      points: dailyPoints, value: 'cost', color: '#8b5cf6', label: '消费',
      format: (v) => ui.usd(v), xFormat: (ts) => ui.fmtDate(ts, false).slice(5),
    });
    el.querySelectorAll('#usage-status [data-status]').forEach((btn) => btn.addEventListener('click', () => { status = btn.dataset.status; page = 1; load().catch((err) => ui.toast(err.message, 'error')); }));
    ui.attachPagination(el.querySelector('.table-foot'), (p) => { page = p; load().catch((err) => ui.toast(err.message, 'error')); });
  };

  await load();
}

export const portalPages = {
  overview: portalOverview,
  keys: portalKeys,
  models: portalModels,
  playground,
  usage: portalUsage,
};
