import { api, ApiError } from './api.js';
import * as ui from './ui.js';

const app = document.getElementById('app');

const ADMIN_ROLES = ['SUPER_ADMIN', 'ORG_ADMIN', 'AUDITOR'];

const NAV = {
  admin: [
    {
      section: '平台运维',
      items: [
        { key: 'overview', label: '运营概览', icon: 'grid' },
        { key: 'channels', label: '渠道管理', icon: 'server', roles: ['SUPER_ADMIN', 'AUDITOR'] },
        { key: 'models', label: '模型与路由', icon: 'route', roles: ['SUPER_ADMIN', 'AUDITOR'] },
      ],
    },
    {
      section: '组织与权限',
      items: [
        { key: 'users', label: '用户与组织', icon: 'users' },
        { key: 'keys', label: 'API Key', icon: 'key' },
      ],
    },
    {
      section: '可观测与财务',
      items: [
        { key: 'logs', label: '调用日志', icon: 'list' },
        { key: 'billing', label: '财务报表', icon: 'receipt' },
        { key: 'audit', label: '审计日志', icon: 'shield', roles: ['SUPER_ADMIN', 'AUDITOR'] },
      ],
    },
    {
      section: '系统',
      items: [{ key: 'settings', label: '系统设置', icon: 'settings', roles: ['SUPER_ADMIN'] }],
    },
  ],
  portal: [
    {
      section: '开发者空间',
      items: [
        { key: 'overview', label: '工作台', icon: 'grid' },
        { key: 'keys', label: '我的 API Key', icon: 'key' },
        { key: 'models', label: '模型广场', icon: 'layers' },
        { key: 'playground', label: '在线调试', icon: 'terminal' },
        { key: 'usage', label: '用量与账单', icon: 'bar-chart' },
      ],
    },
  ],
};

const PAGE_META = {
  admin: {
    overview: ['运营概览', '实时流量、渠道健康与平台成本态势'],
    channels: ['渠道管理', '上游供应商、Master Key 池、优先级与熔断控制'],
    models: ['模型与路由', '统一模型别名、价格字典与跨厂商降级链'],
    users: ['用户与组织', '部门层级、成员状态与多级预算配额'],
    keys: ['API Key 管理', '全平台密钥检索、限额配置与强制吊销'],
    logs: ['调用日志', '按请求追踪链路元数据、耗时与 Token 计费'],
    billing: ['财务报表', '按组织、模型、用户与日期维度核对成本'],
    audit: ['审计日志', '管理员操作与安全事件的不可变记录'],
    settings: ['系统设置', '路由策略、配额阈值、告警与 SSO 配置'],
  },
  portal: {
    overview: ['工作台', '额度、用量与快速接入'],
    keys: ['我的 API Key', '自助签发、限额配置与生命周期管理'],
    models: ['模型广场', '可用模型、价格与能力目录'],
    playground: ['在线调试', '直接在浏览器中验证模型与网关链路'],
    usage: ['用量与账单', '个人请求明细与每日消费趋势'],
  },
};

let adminPages = null;
let portalPages = null;
let currentCleanup = null;
let shellReady = false;
let liveTimer = null;
let unauthorizedHandled = false;

const state = {
  user: null,
  permissions: { admin: false, manage_platform: false, read_only: false },
  config: { platform_name: 'LLM Gateway', sso_providers: [], local_login_enabled: true },
  area: 'portal',
  page: 'overview',
};

function isAdminRole(role) {
  return ADMIN_ROLES.includes(role);
}

function allowedNav(area) {
  return NAV[area].map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.roles || item.roles.includes(state.user.role)),
  })).filter((section) => section.items.length);
}

function currentPageMeta() {
  return PAGE_META[state.area]?.[state.page] || ['LLM Gateway', ''];
}

function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return null;
  return next;
}

function showLoginError(message) {
  const el = document.querySelector('.login-error');
  if (el) {
    el.textContent = message;
    el.classList.remove('hidden');
  } else {
    ui.toast(message, 'error');
  }
}

function renderLogin() {
  shellReady = false;
  clearInterval(liveTimer);
  const query = new URLSearchParams(location.search);
  const ssoError = query.get('sso_error');
  const next = safeNext(query.get('next'));
  const cfg = state.config || {};
  const sso = cfg.sso_providers || [];
  document.title = `登录 · ${cfg.platform_name || 'LLM Gateway'}`;
  app.innerHTML = `
    <div class="login-page">
      <section class="login-hero">
        <div>
          <div class="login-brand">
            <div class="brand-mark"><svg viewBox="0 0 32 32" width="24" height="24"><path d="M9 22 16 9l7 13h-3.6L16 15.4 12.6 22H9Z" fill="#fff"/></svg></div>
            <div><div class="brand-name">${ui.escapeHtml(cfg.platform_name || 'LLM Gateway')}</div><div class="brand-sub">Corporate AI Infrastructure</div></div>
          </div>
          <div class="login-hero-main">
            <div class="login-eyebrow">${ui.icon('zap', 12)} 企业级大模型中转平台</div>
            <h1>一个入口，<br/>连接<span class="grad-text">所有大模型</span></h1>
            <p>统一纳管 OpenAI、Anthropic、DeepSeek、通义千问与内网私有模型。100% 兼容 OpenAI 协议，内置智能路由、故障自动降级、额度计量与全链路审计。</p>
            <div class="login-features">
              <div class="login-feature">${ui.icon('code', 16)}<div><b>零代码接入</b><span>仅替换 BaseURL 与 API Key，官方 SDK 直接可用</span></div></div>
              <div class="login-feature">${ui.icon('route', 16)}<div><b>跨厂商容灾</b><span>优先级降级链、断路器与毫秒级故障切换</span></div></div>
              <div class="login-feature">${ui.icon('gauge', 16)}<div><b>精细配额</b><span>部门 / 项目 / 个人 / Key 四级预算与限流</span></div></div>
              <div class="login-feature">${ui.icon('shield', 16)}<div><b>安全合规</b><span>密钥 AES-256 加密、脱敏审计与 SSO 单点登录</span></div></div>
            </div>
          </div>
        </div>
        <div class="login-foot">© ${new Date().getFullYear()} Corporate Platform · LLM API Gateway v1.0</div>
      </section>
      <section class="login-panel">
        <div class="login-card">
          <h2>欢迎回来</h2>
          <div class="sub">使用企业账号登录统一模型中转平台</div>
          <div class="login-error ${ssoError ? '' : 'hidden'}">${ui.escapeHtml(ssoError || '')}</div>
          ${cfg.local_login_enabled === false ? '' : `
          <form class="login-form" id="login-form" autocomplete="on">
            <div class="field">
              <label for="email">企业邮箱</label>
              <div class="input-icon">${ui.icon('mail', 15)}<input id="email" name="email" type="email" placeholder="you@corp.local" autocomplete="username" required></div>
            </div>
            <div class="field">
              <label for="password">密码</label>
              <div class="input-icon">${ui.icon('lock', 15)}<input id="password" name="password" type="password" placeholder="请输入密码" autocomplete="current-password" required></div>
            </div>
            <button class="btn primary lg block" type="submit" id="login-submit">登录控制台 ${ui.icon('arrow', 16)}</button>
          </form>`}
          ${sso.length ? `
            <div class="login-divider">或使用企业统一认证</div>
            <div class="sso-list">
              ${sso.map((p) => `<a class="sso-btn" href="/auth/sso/${encodeURIComponent(p.id)}/start?next=${encodeURIComponent(next || '/portal')}">${ui.icon(p.type === 'feishu' ? 'zap' : p.type === 'dingtalk' ? 'globe' : 'shield', 16)} 使用 ${ui.escapeHtml(p.name)} 登录</a>`).join('')}
            </div>` : ''}
          ${cfg.demo_mode ? `
            <div class="login-demo">
              <b>演示环境</b><br/>
              管理员 admin@corp.local / ${ui.escapeHtml(cfg.demo_credentials?.password || '')}<br/>
              开发者 dev@corp.local / ${ui.escapeHtml(cfg.demo_credentials?.password || '')}
              <div class="mt-8"><button type="button" id="fill-demo">填入管理员账号</button> · <button type="button" id="fill-demo-dev">填入开发者账号</button></div>
            </div>` : ''}
          <div class="login-back"><a href="/healthz" target="_blank">服务健康状态</a> · <span class="mono">v1.0.0</span></div>
        </div>
      </section>
    </div>`;

  const form = document.getElementById('login-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('login-submit');
      const email = form.email.value.trim();
      const password = form.password.value;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> 正在登录…';
      try {
        const data = await api('/auth/login', { method: 'POST', body: { email, password } });
        const target = next && (isAdminRole(data.user.role) || !next.startsWith('/admin')) ? next : (isAdminRole(data.user.role) ? '/admin' : '/portal');
        location.href = target;
      } catch (err) {
        showLoginError(err.message);
        btn.disabled = false;
        btn.innerHTML = `登录控制台 ${ui.icon('arrow', 16)}`;
      }
    });
    const fill = (email) => {
      form.email.value = email;
      form.password.value = cfg.demo_credentials?.password || '';
      form.password.focus();
    };
    document.getElementById('fill-demo')?.addEventListener('click', () => fill('admin@corp.local'));
    document.getElementById('fill-demo-dev')?.addEventListener('click', () => fill('dev@corp.local'));
  } else {
    document.getElementById('fill-demo')?.addEventListener('click', () => {
      const f = document.getElementById('login-form');
      if (f) { f.email.value = 'admin@corp.local'; f.password.value = cfg.demo_credentials?.password || ''; }
    });
  }
}

function navMarkup() {
  return allowedNav(state.area).map((section) => `
    <div class="nav-section">${ui.escapeHtml(section.section)}</div>
    ${section.items.map((item) => `<a class="nav-item ${item.key === state.page ? 'active' : ''}" data-page="${item.key}" href="/${state.area}#/${item.key}">${ui.icon(item.icon, 17)}<span>${ui.escapeHtml(item.label)}</span></a>`).join('')}
  `).join('');
}

function renderShell() {
  const meta = currentPageMeta();
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark"><svg viewBox="0 0 32 32" width="24" height="24"><path d="M9 22 16 9l7 13h-3.6L16 15.4 12.6 22H9Z" fill="#fff"/></svg></div>
          <div><div class="brand-name">${ui.escapeHtml(state.config.platform_name || 'LLM Gateway')}</div><div class="brand-sub">${state.area === 'admin' ? 'Admin Console' : 'Developer Portal'}</div></div>
        </div>
        <nav class="nav" id="nav">${navMarkup()}</nav>
        <div class="sidebar-foot">
          <div class="user-chip" id="user-chip" role="button" tabindex="0">
            <div class="avatar">${ui.escapeHtml(ui.initials(state.user.name))}</div>
            <div style="min-width:0;flex:1">
              <div class="u-name">${ui.escapeHtml(state.user.name)}</div>
              <div class="u-mail">${ui.escapeHtml(ui.roleName(state.user.role))} · ${ui.escapeHtml(state.user.org_name || '')}</div>
            </div>
            ${ui.icon('chevron-right', 14)}
          </div>
          <button class="btn ghost sm block" id="logout-btn" style="margin-top:4px;justify-content:flex-start">${ui.icon('logout', 15)} 退出登录</button>
        </div>
      </aside>
      <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
      <div class="main">
        <header class="topbar">
          <button class="icon-btn mobile-menu" id="mobile-menu" aria-label="菜单">${ui.icon('menu', 18)}</button>
          <div>
            <div class="topbar-title" id="topbar-title">${ui.escapeHtml(meta[0])}</div>
            <div class="topbar-sub" id="topbar-sub">${ui.escapeHtml(meta[1])}</div>
          </div>
          <div class="topbar-spacer"></div>
          ${state.permissions.admin ? `<span class="qps-pill"><span class="live-dot"></span> 实时 <b id="top-qps">—</b> QPS</span>` : ''}
          <span class="env-pill"><span class="live-dot"></span> ${state.area === 'admin' ? '生产环境' : '个人工作区'}</span>
          <button class="icon-btn" id="top-refresh" title="刷新当前页面">${ui.icon('refresh', 16)}</button>
          ${state.permissions.admin || state.user.role !== 'APP_USER' ? `<button class="icon-btn" id="switch-area" title="${state.area === 'admin' ? '切换到自助门户' : '切换到管理后台'}">${ui.icon(state.area === 'admin' ? 'terminal' : 'shield', 16)}</button>` : ''}
        </header>
        <main class="content" id="page"></main>
      </div>
    </div>`;

  document.getElementById('nav').addEventListener('click', (e) => {
    const link = e.target.closest('[data-page]');
    if (!link) return;
    e.preventDefault();
    navigate(state.area, link.dataset.page);
    closeSidebar();
  });
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.getElementById('user-chip').addEventListener('click', openAccountModal);
  document.getElementById('mobile-menu').addEventListener('click', () => document.getElementById('sidebar').classList.add('open'));
  document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);
  document.getElementById('top-refresh').addEventListener('click', () => renderPage(true));
  document.getElementById('switch-area')?.addEventListener('click', () => {
    window.location.href = state.area === 'admin' ? '/portal#/overview' : '/admin#/overview';
  });
  shellReady = true;
  startLivePoll();
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
}

function updateShellActive() {
  document.querySelectorAll('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === state.page));
  const meta = currentPageMeta();
  const title = document.getElementById('topbar-title');
  const sub = document.getElementById('topbar-sub');
  if (title) title.textContent = meta[0];
  if (sub) sub.textContent = meta[1];
  document.title = `${meta[0]} · ${state.config.platform_name || 'LLM Gateway'}`;
  const switchBtn = document.getElementById('switch-area');
  if (switchBtn) switchBtn.title = state.area === 'admin' ? '切换到自助门户' : '切换到管理后台';
}

function startLivePoll() {
  clearInterval(liveTimer);
  if (!state.permissions.admin) return;
  const tick = async () => {
    try {
      const live = await api('/api/admin/live');
      const el = document.getElementById('top-qps');
      if (el) el.textContent = Number(live.qps || 0).toFixed(1);
    } catch { /* silent */ }
  };
  tick();
  liveTimer = setInterval(tick, 12000);
}

function openAccountModal() {
  const { close } = ui.openModal({
    title: '账户信息',
    size: 'narrow',
    body: `
      <div class="flex-center gap-12" style="margin-bottom:16px">
        <div class="avatar" style="width:46px;height:46px;font-size:15px">${ui.escapeHtml(ui.initials(state.user.name))}</div>
        <div><div style="font-weight:650;font-size:15px">${ui.escapeHtml(state.user.name)}</div><div class="text-xs muted">${ui.escapeHtml(state.user.email)}</div></div>
      </div>
      <dl class="kv">
        <dt>角色</dt><dd>${ui.badge(ui.roleName(state.user.role), ui.roleTone(state.user.role))}</dd>
        <dt>所属组织</dt><dd>${ui.escapeHtml(state.user.org_name || '—')}</dd>
        <dt>工作区</dt><dd>${state.area === 'admin' ? '管理后台' : '自助门户'}</dd>
        <dt>登录方式</dt><dd>企业账号</dd>
      </dl>`,
    footer: `<button class="btn" data-close>关闭</button>${state.area === 'admin' && isAdminRole(state.user.role) ? `<button class="btn" id="go-portal">前往自助门户</button>` : ''}${state.user.role !== 'SUPER_ADMIN' ? '' : `<button class="btn" id="go-admin">管理后台</button>`}`,
    onMount(el, closeFn) {
      el.querySelector('#go-portal')?.addEventListener('click', () => { window.location.href = '/portal#/overview'; });
      el.querySelector('#go-admin')?.addEventListener('click', () => { window.location.href = '/admin#/overview'; });
    },
  });
  return close;
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.href = '/login';
}

async function loadPages() {
  if (!adminPages) {
    const mod = await import('./pages/admin.js');
    adminPages = mod.adminPages;
  }
  if (!portalPages) {
    const mod = await import('./pages/portal.js');
    portalPages = mod.portalPages;
  }
}

function resolveRoute() {
  if (!state.user) return null;
  let area = location.pathname.startsWith('/admin') ? 'admin' : location.pathname.startsWith('/portal') ? 'portal' : (state.permissions.admin ? 'admin' : 'portal');
  if (area === 'admin' && !state.permissions.admin) {
    area = 'portal';
    if (location.pathname.startsWith('/admin')) history.replaceState({}, '', '/portal#/overview');
  }
  const hash = location.hash.replace(/^#\/?/, '');
  const pages = adminPages ? Object.keys(adminPages) : [];
  let page = hash || 'overview';
  const allowed = allowedNav(area).flatMap((s) => s.items.map((i) => i.key));
  if (!allowed.includes(page)) page = 'overview';
  return { area, page };
}

async function renderPage(force = false) {
  if (!state.user) return;
  await loadPages();
  const route = resolveRoute();
  if (!route) return;
  if (force) {
    // no-op, simply re-render
  }
  const areaChanged = route.area !== state.area;
  state.area = route.area;
  state.page = route.page;
  if (!shellReady || areaChanged) {
    renderShell();
  } else {
    updateShellActive();
  }
  if (currentCleanup) {
    try { currentCleanup(); } catch { /* ignore */ }
    currentCleanup = null;
  }
  const pageEl = document.getElementById('page');
  pageEl.innerHTML = ui.skeletonPage(state.area === 'portal' && state.page === 'playground' ? 3 : 4);
  const pages = state.area === 'admin' ? adminPages : portalPages;
  const render = pages[state.page];
  if (!render) {
    pageEl.innerHTML = `<div class="notice danger">${ui.icon('alert', 16)} 页面不存在或无权访问</div>`;
    return;
  }
  try {
    const cleanup = await render(pageEl, {
      state,
      navigate: (area, page) => navigate(area, page),
      reload: () => renderPage(true),
      toast: ui.toast,
    });
    currentCleanup = typeof cleanup === 'function' ? cleanup : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return;
    pageEl.innerHTML = `<div class="notice danger">${ui.icon('alert', 16)}<div><b>页面加载失败</b><div class="mt-8">${ui.escapeHtml(err.message || '未知错误')}</div></div></div>`;
  }
}

function navigate(area, page) {
  const target = `/${area}#/${page}`;
  if (location.pathname + location.hash === target) {
    renderPage(true);
    return;
  }
  history.pushState({}, '', target);
  renderPage(true);
}

async function boot() {
  window.addEventListener('gateway:unauthorized', () => {
    if (!state.user || unauthorizedHandled || location.pathname === '/login') return;
    unauthorizedHandled = true;
    ui.toast('登录状态已失效，请重新登录', 'warning');
    setTimeout(() => { location.href = '/login'; }, 800);
  });
  try {
    state.config = await api('/auth/config');
  } catch { /* keep defaults */ }
  try {
    const me = await api('/auth/me');
    state.user = me.user;
    state.permissions = me.permissions || { admin: isAdminRole(me.user.role), manage_platform: me.user.role === 'SUPER_ADMIN', read_only: me.user.role === 'AUDITOR' };
    if (location.pathname === '/login' || location.pathname === '/') {
      location.replace(state.permissions.admin ? '/admin#/overview' : '/portal#/overview');
      return;
    }
  } catch {
    state.user = null;
  }
  if (!state.user) {
    if (location.pathname !== '/login') {
      history.replaceState({}, '', `/login${location.search || ''}`);
    }
    renderLogin();
    return;
  }
  await renderPage();
  window.addEventListener('popstate', () => renderPage());
  window.addEventListener('hashchange', () => renderPage());
}

boot();
