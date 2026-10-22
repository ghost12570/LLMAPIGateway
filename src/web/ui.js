const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  route: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H15a3 3 0 0 1 3 3v6.5"/><path d="M15.5 18H9a3 3 0 0 1-3-3V8.5"/>',
  cpu: '<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 8.5-8.5M15 8l3 3M18 5l3 3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r=".8" fill="currentColor"/><circle cx="3.5" cy="12" r=".8" fill="currentColor"/><circle cx="3.5" cy="18" r=".8" fill="currentColor"/>',
  receipt: '<path d="M6 2h12a1 1 0 0 1 1 1v18l-3-2-3 2-3-2-3 2V3a1 1 0 0 1 1-1Z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.91Z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  zap: '<path d="M13 2 3 14h8l-1 8 10-12h-8l1-8Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  play: '<path d="M6 3l14 9-14 9V3Z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  'x-circle': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  'chevron-left': '<path d="m15 18-6-6 6-6"/>',
  'chevron-right': '<path d="m9 18 6-6-6-6"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  server: '<rect x="2" y="3" width="20" height="7" rx="2"/><rect x="2" y="14" width="20" height="7" rx="2"/><path d="M6 6.5h.01M6 17.5h.01"/>',
  sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z"/><path d="M5 3l.7 1.8L7.5 5.5 5.7 6.2 5 8l-.7-1.8L2.5 5.5l1.8-.7L5 3Z"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  branch: '<circle cx="6" cy="3" r="2"/><circle cx="6" cy="21" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 5v14M18 11c0 3-3 4-6 4H6"/>',
  gauge: '<path d="M12 14l4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  filter: '<path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3Z"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z"/>',
  'rotate-cw': '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  wallet: '<path d="M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2Z"/><path d="M16 14h.01M2 10h20"/>',
  'bar-chart': '<path d="M12 20V10M18 20V4M6 20v-6"/>',
  'trending-up': '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  'file-text': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  'sliders': '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
};

export function icon(name, size = 18) {
  const inner = ICONS[name] || ICONS.info;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function num(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function compact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 2)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)}万`;
  return n.toLocaleString('zh-CN');
}

export function usd(value, digits) {
  const n = Number(value) || 0;
  if (digits !== undefined) return `$${n.toFixed(digits)}`;
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(5)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${compact(n)}`;
}

export function cny(value, rate = 7.2) {
  const n = (Number(value) || 0) * rate;
  if (n === 0) return '¥0.00';
  if (n < 0.01) return `¥${n.toFixed(4)}`;
  if (n < 1) return `¥${n.toFixed(2)}`;
  if (n < 10000) return `¥${n.toFixed(2)}`;
  return `¥${compact(n)}`;
}

export function price(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0';
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

export function percent(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtDate(ts, withTime = true) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return withTime
    ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function timeOfDay(ts) {
  const d = new Date(Number(ts));
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function timeAgo(ts) {
  if (!ts) return '从未';
  const diff = Date.now() - Number(ts);
  if (diff < 0) return '刚刚';
  if (diff < 15000) return '刚刚';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 86400000 * 30) return `${Math.floor(diff / 86400000)} 天前`;
  return fmtDate(ts, false);
}

export function duration(ms) {
  if (ms === null || ms === undefined) return '—';
  const n = Number(ms);
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}s`;
  return `${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
}

export function initials(name) {
  const str = String(name || '?').trim();
  if (!str) return '?';
  if (/[\u4e00-\u9fa5]/.test(str)) return str.slice(0, 1);
  return str.split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase().slice(0, 2);
}

export function roleName(role) {
  return {
    SUPER_ADMIN: '超级管理员',
    ORG_ADMIN: '部门管理员',
    APP_USER: '普通用户',
    AUDITOR: '审计员',
  }[role] || role;
}

export function roleTone(role) {
  return { SUPER_ADMIN: 'violet', ORG_ADMIN: 'cyan', APP_USER: 'blue', AUDITOR: 'amber' }[role] || 'gray';
}

export function providerName(provider) {
  return {
    openai: 'OpenAI', azure: 'Azure', anthropic: 'Anthropic', deepseek: 'DeepSeek',
    dashscope: '百炼', custom: '私有部署',
  }[provider] || provider || '—';
}

export function providerTone(provider) {
  return { openai: 'green', azure: 'blue', anthropic: 'amber', deepseek: 'violet', dashscope: 'cyan', custom: 'gray' }[provider] || 'gray';
}

export function capabilityLabel(cap) {
  return {
    chat: '对话', vision: '视觉', tools: '工具调用', reasoning: '推理', embedding: '向量',
    coding: '代码', router: '智能路由',
  }[cap] || cap;
}

export function statusMeta(status, httpStatus) {
  if (status === 'success') return { label: '成功', tone: 'green' };
  if (status === 'cancelled') return { label: '已取消', tone: 'amber' };
  if (httpStatus === 499) return { label: '已取消', tone: 'amber' };
  return { label: '失败', tone: 'red' };
}

export function circuitMeta(state) {
  return {
    closed: { label: '正常', tone: 'green', dot: 'green' },
    open: { label: '熔断', tone: 'red', dot: 'red' },
    half_open: { label: '半开', tone: 'amber', dot: 'amber' },
  }[state] || { label: '未知', tone: 'gray', dot: 'gray' };
}

export function badge(text, tone = 'gray') {
  return `<span class="badge ${tone}">${escapeHtml(text)}</span>`;
}

export function tag(text) {
  const t = String(text || '').toUpperCase();
  return `<span class="tag ${t === 'PROD' ? 'prod' : t === 'DEV' ? 'dev' : ''}">${escapeHtml(t)}</span>`;
}

export function emptyState(title = '暂无数据', desc = '', iconName = 'layers') {
  return `<div class="empty">${icon(iconName, 36)}<div class="empty-title">${escapeHtml(title)}</div>${desc ? `<div>${escapeHtml(desc)}</div>` : ''}</div>`;
}

export function toast(message, type = 'info', ms = 3800) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const iconName = { success: 'check-circle', error: 'x-circle', warning: 'alert', info: 'info' }[type] || 'info';
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${icon(iconName, 16)}<div>${escapeHtml(message)}</div>`;
  root.appendChild(el);
  const timer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-6px)';
    el.style.transition = 'all .2s';
    setTimeout(() => el.remove(), 220);
  }, ms);
  el.addEventListener('click', () => { clearTimeout(timer); el.remove(); });
}

let modalScrollLocks = 0;
function lockScroll() {
  modalScrollLocks++;
  document.body.style.overflow = 'hidden';
}
function unlockScroll() {
  modalScrollLocks = Math.max(0, modalScrollLocks - 1);
  if (!modalScrollLocks) document.body.style.overflow = '';
}

export function openModal({ title, subtitle = '', body = '', footer = '', size = '', onMount, closeOnBackdrop = true }) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <div>
          <div class="modal-title">${escapeHtml(title)}</div>
          ${subtitle ? `<div class="modal-sub">${escapeHtml(subtitle)}</div>` : ''}
        </div>
        <button type="button" class="icon-btn modal-close" data-close="1" aria-label="关闭">${icon('close', 16)}</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
    </div>`;
  root.appendChild(backdrop);
  lockScroll();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    unlockScroll();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', (e) => {
    if (closeOnBackdrop && e.target === backdrop) close();
  });
  backdrop.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  const modalEl = backdrop.querySelector('.modal');
  onMount?.(modalEl, close);
  return { close, el: modalEl };
}

export function openDrawer({ title, subtitle = '', body = '', footer = '', onMount }) {
  const root = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-backdrop';
  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <div class="modal-title">${escapeHtml(title)}</div>
        ${subtitle ? `<div class="modal-sub">${escapeHtml(subtitle)}</div>` : ''}
      </div>
      <button type="button" class="icon-btn" data-close="1" style="margin-left:auto">${icon('close', 16)}</button>
    </div>
    <div class="drawer-body">${body}</div>
    ${footer ? `<div class="drawer-foot">${footer}</div>` : ''}`;
  root.appendChild(backdrop);
  root.appendChild(drawer);
  lockScroll();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    drawer.remove();
    unlockScroll();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('click', close);
  drawer.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  onMount?.(drawer, close);
  return { close, el: drawer };
}

export function confirmDialog({ title, message, confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    let observer = null;
    let finish = null;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      finish?.();
      resolve(value);
    };
    const { close } = openModal({
      title,
      size: 'narrow',
      body: `<div class="text-sm" style="color:var(--muted);line-height:1.7">${escapeHtml(message)}</div>`,
      footer: `<button class="btn" data-cancel>${escapeHtml(cancelText)}</button><button class="btn ${danger ? 'danger' : 'primary'}" data-confirm>${escapeHtml(confirmText)}</button>`,
      onMount(el, closeFn) {
        finish = closeFn;
        el.querySelector('[data-cancel]').addEventListener('click', () => settle(false));
        el.querySelector('[data-confirm]').addEventListener('click', () => settle(true));
      },
    });
    observer = new MutationObserver(() => {
      if (!document.body.contains(close.el)) settle(false);
    });
    observer.observe(document.getElementById('modal-root'), { childList: true });
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success', 1800);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板', 'success', 1800); } catch { toast('复制失败，请手动选择复制', 'error'); }
    ta.remove();
  }
}

export function sparkline(values, color = '#8b5cf6', width = 120, height = 34) {
  const list = (values || []).map((v) => Number(v) || 0);
  if (!list.length) return '';
  const max = Math.max(...list);
  const min = Math.min(...list);
  const span = max - min || 1;
  const pts = list.map((v, i) => {
    const x = (i / Math.max(1, list.length - 1)) * width;
    const y = height - 3 - ((v - min) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true"><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/></svg>`;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const norm = value / base;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

export function areaChart(container, { points = [], value = 'requests', color = '#8b5cf6', format = compact, xFormat = timeOfDay, label = '请求数' }) {
  if (!container) return;
  const data = points.map((p) => ({ ...p, _v: typeof value === 'function' ? value(p) : Number(p[value]) || 0 }));
  if (!data.length) {
    container.innerHTML = emptyState('暂无趋势数据', '', 'activity');
    return;
  }
  const W = 900;
  const H = 360;
  const PL = 52;
  const PR = 18;
  const PT = 16;
  const PB = 30;
  const maxVal = niceMax(Math.max(...data.map((d) => d._v), 0));
  const x = (i) => PL + (data.length <= 1 ? (W - PL - PR) / 2 : (i / (data.length - 1)) * (W - PL - PR));
  const y = (v) => PT + (1 - (v / (maxVal || 1))) * (H - PT - PB);
  const gradId = `grad${Math.random().toString(36).slice(2, 8)}`;
  let line = '';
  data.forEach((d, i) => { line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d._v).toFixed(1)}`; });
  const area = `${line}L${x(data.length - 1).toFixed(1)},${H - PB}L${x(0).toFixed(1)},${H - PB}Z`;
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const v = (maxVal / 4) * i;
    const yy = y(v);
    grid += `<line x1="${PL}" y1="${yy}" x2="${W - PR}" y2="${yy}" stroke="rgba(148,163,208,.09)" stroke-width="1"/>`;
    grid += `<text x="${PL - 10}" y="${yy + 3.5}" text-anchor="end" fill="#5c698a" font-size="10" font-family="var(--mono)">${escapeHtml(compact(v))}</text>`;
  }
  const xLabels = [];
  const labelCount = Math.min(6, data.length);
  for (let i = 0; i < labelCount; i++) {
    const idx = Math.round((i / Math.max(1, labelCount - 1)) * (data.length - 1));
    xLabels.push(`<text x="${x(idx)}" y="${H - 9}" text-anchor="${i === 0 ? 'start' : i === labelCount - 1 ? 'end' : 'middle'}" fill="#5c698a" font-size="10">${escapeHtml(xFormat(data[idx].ts))}</text>`);
  }
  const last = data[data.length - 1];
  container.innerHTML = `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(label)}趋势图">
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity=".28"/><stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${area}" fill="url(#${gradId})"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(data.length - 1)}" cy="${y(last._v)}" r="3.5" fill="${color}" stroke="#0d1320" stroke-width="2"/>
      ${xLabels.join('')}
      <rect class="chart-hit" x="${PL}" y="${PT}" width="${W - PL - PR}" height="${H - PT - PB}" fill="transparent"/>
      <line class="hover-line" x1="0" y1="${PT}" x2="0" y2="${H - PB}" stroke="rgba(148,163,208,.28)" stroke-dasharray="3 3" opacity="0"/>
      <circle class="hover-dot" cx="0" cy="0" r="4" fill="${color}" stroke="#0d1320" stroke-width="2" opacity="0"/>
    </svg>
    <div class="chart-tooltip"></div>
  </div>`;
  const wrap = container.querySelector('.chart-wrap');
  const svg = container.querySelector('svg');
  const tip = container.querySelector('.chart-tooltip');
  const hoverLine = container.querySelector('.hover-line');
  const hoverDot = container.querySelector('.hover-dot');
  const hit = container.querySelector('.chart-hit');
  if (!hit) return;
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.max(0, Math.min(data.length - 1, Math.round(((relX - PL) / (W - PL - PR)) * (data.length - 1))));
    const d = data[idx];
    const px = x(idx);
    const py = y(d._v);
    hoverLine.setAttribute('x1', px); hoverLine.setAttribute('x2', px); hoverLine.setAttribute('opacity', '1');
    hoverDot.setAttribute('cx', px); hoverDot.setAttribute('cy', py); hoverDot.setAttribute('opacity', '1');
    tip.innerHTML = `<div class="tt-time">${escapeHtml(fmtDate(d.ts))}</div><div>${escapeHtml(label)}：<b>${escapeHtml(format(d._v))}</b></div>`;
    tip.style.left = `${(px / W) * 100}%`;
    tip.style.top = `${(py / H) * 100}%`;
    tip.style.opacity = '1';
  };
  hit.addEventListener('mousemove', move);
  hit.addEventListener('mouseleave', () => {
    tip.style.opacity = '0';
    hoverLine.setAttribute('opacity', '0');
    hoverDot.setAttribute('opacity', '0');
  });
}

export function donut(items = [], { centerLabel = '总计', centerValue = '0', size = 148, thickness = 13, format = compact } = {}) {
  const total = items.reduce((sum, i) => sum + (Number(i.value) || 0), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  let circles = '';
  if (total <= 0) {
    circles = `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="rgba(148,163,208,.12)" stroke-width="${thickness}"/>`;
  } else {
    for (const item of items) {
      const v = Number(item.value) || 0;
      if (!v) continue;
      const len = (v / total) * c;
      circles += `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${item.color}" stroke-width="${thickness}" stroke-dasharray="${Math.max(0, len - 2)} ${c - Math.max(0, len - 2)}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"/>`;
      offset += len;
    }
  }
  return `<div class="donut-wrap">
    <div style="position:relative;flex:0 0 auto;width:${size}px;height:${size}px">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${circles}
        <text x="${size / 2}" y="${size / 2 - 4}" text-anchor="middle" fill="#e8edfb" font-size="20" font-weight="650">${escapeHtml(centerValue)}</text>
        <text x="${size / 2}" y="${size / 2 + 14}" text-anchor="middle" fill="#647195" font-size="9.5">${escapeHtml(centerLabel)}</text>
      </svg>
    </div>
    <div class="donut-legend">
      ${items.map((item) => `<div class="legend-item"><span class="swatch" style="background:${item.color}"></span><span>${escapeHtml(item.label)}</span><span class="val">${escapeHtml(format(item.value))}</span></div>`).join('')}
    </div>
  </div>`;
}

export function paginationHtml({ page = 1, pages = 1, total = 0 }) {
  const buttons = [];
  buttons.push(`<button class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''} aria-label="上一页">${icon('chevron-left', 13)}</button>`);
  const set = new Set([1, pages, page - 1, page, page + 1]);
  const list = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  let last = 0;
  for (const p of list) {
    if (p - last > 1) buttons.push('<span class="ellipsis">…</span>');
    buttons.push(`<button class="page-btn ${p === page ? 'active' : ''}" data-page="${p}">${p}</button>`);
    last = p;
  }
  buttons.push(`<button class="page-btn" data-page="${page + 1}" ${page >= pages ? 'disabled' : ''} aria-label="下一页">${icon('chevron-right', 13)}</button>`);
  return { buttons: buttons.join(''), meta: `共 ${num(total)} 条 · 第 ${page} / ${Math.max(1, pages)} 页` };
}

export function attachPagination(container, onChange) {
  container.querySelectorAll('[data-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = Number(btn.dataset.page);
      if (p >= 1 && !btn.disabled) onChange(p);
    });
  });
}

export function skeletonPage(columns = 4) {
  return `<div class="page-loading">
    <div class="grid grid-${columns}">${Array.from({ length: columns }).map(() => '<div class="skeleton skeleton-card"></div>').join('')}</div>
    <div class="card"><div class="card-body"><div class="skeleton skeleton-line" style="width:35%"></div><div class="skeleton skeleton-line" style="width:90%"></div><div class="skeleton skeleton-line" style="width:75%"></div><div class="skeleton skeleton-line" style="width:83%"></div><div class="skeleton skeleton-line" style="width:60%"></div></div></div>
  </div>`;
}

export function statusBadge(status, httpStatus) {
  const m = statusMeta(status, httpStatus);
  return badge(m.label, m.tone);
}

export function htmlToElement(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}
