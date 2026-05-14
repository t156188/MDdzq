import MarkdownIt from 'markdown-it';
import taskLists from 'markdown-it-task-lists';
import deflist from 'markdown-it-deflist';
import hljs from 'highlight.js';
import katex from 'katex';
import renderMathInElement from 'katex/contrib/auto-render';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(str, lang) {
    if (lang === 'mermaid') {
      // Mark mermaid blocks; we transform them after render.
      return `<pre class="mermaid-placeholder" data-src="${escapeAttr(str)}"></pre>`;
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre><code class="hljs language-${lang}">${
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        }</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre><code class="hljs">${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

md.use(taskLists, { enabled: true, label: true });
md.use(deflist);

function escapeAttr(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let mermaidLoaded = false;
async function ensureMermaid() {
  if (mermaidLoaded) return;
  // mermaid.bundle.js is shipped alongside; expose itself as window.MDMermaid.
  const script = document.createElement('script');
  script.src = 'vendor/mermaid.bundle.js';
  await new Promise((res, rej) => {
    script.onload = res;
    script.onerror = rej;
    document.head.appendChild(script);
  });
  window.MDMermaid.default.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
  });
  mermaidLoaded = true;
}

async function renderMermaidBlocks(root) {
  const placeholders = root.querySelectorAll('pre.mermaid-placeholder');
  if (!placeholders.length) return;
  await ensureMermaid();
  const mermaid = window.MDMermaid.default;
  let i = 0;
  for (const el of placeholders) {
    const src = decodeHtml(el.getAttribute('data-src') || '');
    const id = `mmd-${Date.now()}-${i++}`;
    try {
      const { svg } = await mermaid.render(id, src);
      const wrap = document.createElement('div');
      wrap.className = 'mermaid';
      wrap.innerHTML = svg;
      el.replaceWith(wrap);
    } catch (err) {
      const errEl = document.createElement('pre');
      errEl.className = 'mermaid-error';
      errEl.textContent = `Mermaid render error: ${err?.message || err}`;
      el.replaceWith(errEl);
    }
  }
}

function decodeHtml(s) {
  const t = document.createElement('textarea');
  t.innerHTML = s;
  return t.value;
}

function renderMath(root) {
  renderMathInElement(root, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\[', right: '\\]', display: true },
    ],
    throwOnError: false,
  });
}

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'section';
}

function assignHeadingIds(root) {
  const headings = root.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const used = new Map();
  const outline = [];
  for (const h of headings) {
    const text = (h.textContent || '').trim();
    const base = slugify(text);
    const count = used.get(base) || 0;
    const id = count === 0 ? base : `${base}-${count}`;
    used.set(base, count + 1);
    h.id = id;
    outline.push({ id, level: Number(h.tagName[1]), text });
  }
  return outline;
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre > code.hljs')) {
    const wrapper = pre.parentElement;
    if (wrapper.querySelector('.copy-btn')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.type = 'button';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText);
        btn.textContent = 'Copied';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      } catch {
        btn.textContent = 'Failed';
      }
    });
    wrapper.classList.add('code-wrap');
    wrapper.appendChild(btn);
  }
}

function updateEmptyState() {
  const empty = document.getElementById('empty-state');
  const root = document.getElementById('root');
  if (!empty || !root) return;
  empty.hidden = root.children.length > 0;
}

async function render(text, baseDir) {
  const root = document.getElementById('root');
  // Rewrite relative image paths to file:// URLs so WKWebView's
  // file-URL access whitelist (granted in Swift) can fetch them.
  if (baseDir) {
    md.normalizeLink = (url) => {
      if (/^[a-z][a-z0-9+\-.]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) {
        return url;
      }
      try {
        return new URL(url, baseDir).toString();
      } catch {
        return url;
      }
    };
    md.validateLink = () => true;
  }
  const html = md.render(text || '');
  root.innerHTML = html;
  const outline = assignHeadingIds(root);
  addCopyButtons(root);
  renderMath(root);
  await renderMermaidBlocks(root);
  // Reset scroll for new document.
  const main = document.getElementById('main') || document.scrollingElement;
  if (main) main.scrollTop = 0;
  Sidebar.setOutline(outline);
  updateEmptyState();
  try {
    window.webkit?.messageHandlers?.didRender?.postMessage({ length: text.length });
  } catch {}
}

function scrollToAnchor(id) {
  const el = document.getElementById(id);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

function setTheme(arg) {
  // Accept either a string ('light'/'dark') or {name, pref}. The pref is the
  // user's choice (system/light/dark) — name is the resolved effective theme.
  let name, pref;
  if (typeof arg === 'string') {
    name = arg;
  } else if (arg && typeof arg === 'object') {
    name = arg.name;
    pref = arg.pref;
  }
  if (name) {
    document.documentElement.dataset.theme = name === 'dark' ? 'dark' : 'light';
    if (mermaidLoaded && window.MDMermaid) {
      // Re-init mermaid with new theme; existing diagrams stay until next render.
      window.MDMermaid.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: name === 'dark' ? 'dark' : 'default',
      });
    }
  }
  if (pref) {
    Sidebar.setThemePref(pref);
  }
}

// ===================================================================
// Sidebar (Files + Outline) — lives entirely in the front-end so both
// the macOS WKWebView host and the Windows Tauri host get the same UI.
// Native shells push the file tree via MDViewerAPI.setFileTree(payload).
// File clicks go back to the host via requestOpenFile(path).
// ===================================================================

function requestOpenFile(path) {
  try {
    if (window.webkit?.messageHandlers?.openFile) {
      window.webkit.messageHandlers.openFile.postMessage({ path });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev && typeof ev.emit === 'function') {
      ev.emit('mdreader:open-file', path);
    }
  } catch {}
}

const Sidebar = (() => {
  let currentTree = null;        // { root, current }
  let currentOutline = [];
  const expanded = new Set();    // paths of expanded dirs
  let lastTreeKey = '';          // memoize tree shape so re-renders are cheap
  let currentThemePref = 'system';

  function el(id) { return document.getElementById(id); }

  function init() {
    const sb = el('sidebar');
    if (!sb) return;

    const w = parseInt(localStorage.getItem('mdreader.sb.width') || '260', 10);
    if (Number.isFinite(w) && w >= 160 && w <= 480) sb.style.width = `${w}px`;

    setCollapsed(localStorage.getItem('mdreader.sb.collapsed') === '1');
    setTab(localStorage.getItem('mdreader.sb.tab') || 'files');

    document.querySelectorAll('.sb-tab').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
    el('sb-collapse')?.addEventListener('click', () => setCollapsed(true));
    el('sb-expand')?.addEventListener('click', () => setCollapsed(false));
    document.querySelectorAll('.sb-theme-item').forEach((it) => {
      it.addEventListener('click', () => {
        const pref = it.dataset.pref;
        setThemePref(pref);
        requestSetThemePref(pref);
      });
    });
    document.querySelectorAll('.sb-fortune-item').forEach((it) => {
      it.addEventListener('click', () => {
        const kind = it.dataset.kind;
        showFortune(kind || 'coin');
      });
    });

    // Initial render — pref is overridden once the host pushes its real value.
    setThemePref(localStorage.getItem('mdreader.theme.pref') || 'system');

    initResize();
    updateEmptyState();
  }

  function setThemePref(pref) {
    if (pref !== 'system' && pref !== 'light' && pref !== 'dark') pref = 'system';
    currentThemePref = pref;
    localStorage.setItem('mdreader.theme.pref', pref);
    renderThemeButton();
  }

  function renderThemeButton() {
    const btn = el('sb-theme-btn');
    if (!btn) return;
    const icon = btn.querySelector('.sb-theme-icon');
    const label = btn.querySelector('.sb-theme-label');
    const map = {
      system: { icon: '◐', label: 'Auto' },
      light:  { icon: '☼', label: 'Light' },
      dark:   { icon: '☾', label: 'Dark' },
    };
    const m = map[currentThemePref] || map.system;
    if (icon) icon.textContent = m.icon;
    if (label) label.textContent = m.label;
    btn.title = `Theme: ${m.label}. Click to cycle.`;
  }

  function cycleThemePref() {
    const order = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(currentThemePref) + 1) % order.length];
    setThemePref(next);            // optimistic local update
    requestSetThemePref(next);     // tell native to persist + re-resolve
  }

  function setTab(name) {
    if (name !== 'files' && name !== 'outline') name = 'files';
    document.querySelectorAll('.sb-tab').forEach((btn) => {
      btn.setAttribute('aria-selected', btn.dataset.tab === name ? 'true' : 'false');
    });
    const filesPane = el('sb-pane-files');
    const outlinePane = el('sb-pane-outline');
    if (filesPane) filesPane.hidden = name !== 'files';
    if (outlinePane) outlinePane.hidden = name !== 'outline';
    const sb = el('sidebar');
    if (sb) sb.dataset.tab = name;
    localStorage.setItem('mdreader.sb.tab', name);
  }

  function setCollapsed(collapsed) {
    const sb = el('sidebar');
    const exp = el('sb-expand');
    if (sb) sb.hidden = !!collapsed;
    if (exp) exp.hidden = !collapsed;
    localStorage.setItem('mdreader.sb.collapsed', collapsed ? '1' : '0');
  }

  function toggleCollapsed() {
    const sb = el('sidebar');
    setCollapsed(!(sb && sb.hidden));
  }

  function initResize() {
    const handle = el('sb-resize');
    const sb = el('sidebar');
    if (!handle || !sb) return;
    let dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(160, Math.min(480, e.clientX));
      sb.style.width = `${w}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      localStorage.setItem('mdreader.sb.width', String(sb.offsetWidth));
    });
  }

  function setFileTree(payload) {
    currentTree = payload && payload.root ? payload : null;
    autoExpand();
    renderFiles();
  }

  function setOutline(items) {
    currentOutline = Array.isArray(items) ? items : [];
    renderOutline();
  }

  function autoExpand() {
    if (!currentTree?.root) return;
    const key = treeKey(currentTree.root);
    if (key !== lastTreeKey) {
      expanded.clear();
      lastTreeKey = key;
    }
    expanded.add(currentTree.root.path);
    const target = currentTree.current;
    if (!target) return;
    walk(currentTree.root, (node, parents) => {
      if (node.path === target) {
        for (const p of parents) expanded.add(p.path);
      }
    });
  }

  function treeKey(node) {
    // A coarse fingerprint: path + children count, recursive. Cheap and
    // good enough to detect "different folder opened" vs "same folder".
    if (!node) return '';
    if (node.type === 'file') return `f:${node.path}`;
    const kids = (node.children || []).map(treeKey).join('|');
    return `d:${node.path}(${kids})`;
  }

  function walk(node, fn, parents = []) {
    fn(node, parents);
    if (node.children) {
      const next = parents.concat(node);
      for (const c of node.children) walk(c, fn, next);
    }
  }

  function renderFiles() {
    const pane = el('sb-pane-files');
    if (!pane) return;
    if (!currentTree?.root) {
      pane.innerHTML = '<div class="sb-empty">No folder open</div>';
      return;
    }
    pane.innerHTML = '';
    pane.appendChild(buildNode(currentTree.root, currentTree.current));
  }

  function buildNode(node, current) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-item';
    row.title = node.path;
    if (node.path === current) row.classList.add('is-current');

    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle';

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name || node.path;

    if (node.type === 'dir') {
      const open = expanded.has(node.path);
      toggle.textContent = open ? '▾' : '▸';
      row.appendChild(toggle);
      row.appendChild(label);
      row.addEventListener('click', () => {
        if (expanded.has(node.path)) expanded.delete(node.path);
        else expanded.add(node.path);
        renderFiles();
      });
      wrap.appendChild(row);
      if (open && node.children?.length) {
        const kids = document.createElement('div');
        kids.className = 'tree-children';
        for (const c of node.children) kids.appendChild(buildNode(c, current));
        wrap.appendChild(kids);
      }
    } else {
      toggle.textContent = '';
      row.appendChild(toggle);
      row.appendChild(label);
      row.addEventListener('click', () => requestOpenFile(node.path));
      wrap.appendChild(row);
    }
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, node);
    });
    return wrap;
  }

  function openContextMenu(x, y, node) {
    if (node.type === 'dir') {
      showContextMenu(x, y, [
        { label: revealLabel(), action: () => fsOp({ op: 'reveal', path: node.path }) },
        { label: 'Copy Path', action: () => copyPath(node.path) },
      ]);
    } else {
      showContextMenu(x, y, [
        { label: 'Open', action: () => requestOpenFile(node.path) },
        { label: revealLabel(), action: () => fsOp({ op: 'reveal', path: node.path }) },
        { label: 'Copy Path', action: () => copyPath(node.path) },
        'separator',
        { label: 'Rename…', action: () => promptRename(node) },
        { label: trashLabel(), danger: true, action: () => confirmDelete(node) },
      ]);
    }
  }

  function renderOutline() {
    const pane = el('sb-pane-outline');
    if (!pane) return;
    if (!currentOutline.length) {
      pane.innerHTML = '<div class="sb-empty">No headings</div>';
      return;
    }
    const minLevel = currentOutline.reduce((m, i) => Math.min(m, i.level), 6);
    pane.innerHTML = '';
    for (const item of currentOutline) {
      const row = document.createElement('div');
      row.className = `outline-item lvl-${item.level}`;
      row.style.paddingLeft = `${(item.level - minLevel) * 12 + 12}px`;
      row.textContent = item.text;
      row.title = item.text;
      row.addEventListener('click', () => {
        document.querySelectorAll('.outline-item').forEach((e) => e.classList.remove('is-current'));
        row.classList.add('is-current');
        scrollToAnchor(item.id);
      });
      pane.appendChild(row);
    }
  }

  return { init, setFileTree, setOutline, setThemePref, toggleCollapsed };
})();

function requestSetThemePref(value) {
  try {
    if (window.webkit?.messageHandlers?.setThemePref) {
      window.webkit.messageHandlers.setThemePref.postMessage(value);
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:set-theme-pref', value);
  } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => Sidebar.init());
} else {
  Sidebar.init();
}

// Suppress the host webview's default context menu (Reload / Inspect / etc.)
// everywhere except where we attached our own handler that called
// preventDefault first — that's what `defaultPrevented` checks.
document.addEventListener('contextmenu', (e) => {
  if (!e.defaultPrevented) e.preventDefault();
});

// Cmd/Ctrl+A in the viewer should only select the *document* (#root) text,
// not the sidebar tree / outline. Native menu Select All goes through the
// same JS via window.MDViewerAPI.selectAllContent (called from the Win shell
// and via this keydown handler on macOS).
function selectAllContent() {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    document.execCommand('selectAll');
    return;
  }
  const target = document.getElementById('root');
  if (!target) return;
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && (e.key === 'a' || e.key === 'A')) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    selectAllContent();
  }
});

// ===================================================================
// File-system ops (right-click → Reveal / Copy Path / Rename / Delete)
// ===================================================================

function isWindowsHost() {
  // Tauri only loads on Windows for this project; WebKit host is Mac.
  return !!window.__TAURI__;
}
function revealLabel() { return isWindowsHost() ? 'Reveal in Explorer' : 'Reveal in Finder'; }
function trashLabel()  { return isWindowsHost() ? 'Move to Recycle Bin' : 'Move to Trash'; }

function fsOp(payload) {
  try {
    if (window.webkit?.messageHandlers?.fsOp) {
      window.webkit.messageHandlers.fsOp.postMessage(payload);
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev?.emit) ev.emit('mdreader:fs-op', payload);
  } catch {}
}

async function copyPath(path) {
  try {
    await navigator.clipboard.writeText(path);
    showToast('Path copied');
  } catch {
    // Clipboard API can be blocked outside user-gesture or in some webviews;
    // ask native to copy via the platform clipboard instead.
    fsOp({ op: 'copyPath', path });
  }
}

async function promptRename(node) {
  const dot = node.name.lastIndexOf('.');
  const stemEnd = dot > 0 ? dot : node.name.length;
  const v = await showModal({
    title: 'Rename',
    input: { value: node.name, selectRange: [0, stemEnd] },
    confirmLabel: 'Rename',
  });
  if (typeof v !== 'string') return;
  const newName = v.trim();
  if (!newName || newName === node.name) return;
  if (/[\\/]/.test(newName)) {
    showToast('Name cannot contain / or \\', 'error');
    return;
  }
  fsOp({ op: 'rename', path: node.path, newName });
}

async function confirmDelete(node) {
  const ok = await showModal({
    title: trashLabel() + '?',
    message: `“${node.name}” will be moved to the system trash. You can restore it from there.`,
    confirmLabel: trashLabel(),
    danger: true,
  });
  if (!ok) return;
  fsOp({ op: 'delete', path: node.path });
}

// ===================================================================
// Context menu, modal, toast — minimal but theme-aware
// ===================================================================

function showContextMenu(x, y, items) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  for (const it of items) {
    if (it === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('div');
    btn.className = 'context-menu-item' + (it.danger ? ' danger' : '');
    btn.textContent = it.label;
    btn.addEventListener('click', () => { closeContextMenu(); it.action(); });
    menu.appendChild(btn);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  // Reposition if it overflows the viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${Math.max(0, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${Math.max(0, y - rect.height)}px`;
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
    document.addEventListener('contextmenu', closeContextMenu, { once: true });
    window.addEventListener('blur', closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu() {
  document.querySelectorAll('.context-menu').forEach((m) => m.remove());
}

function showModal({ title, message, input, danger, confirmLabel }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    const box = document.createElement('div');
    box.className = 'modal-box';

    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = title || '';
    box.appendChild(titleEl);

    if (message) {
      const msgEl = document.createElement('div');
      msgEl.className = 'modal-message';
      msgEl.textContent = message;
      box.appendChild(msgEl);
    }

    let inputEl = null;
    if (input) {
      inputEl = document.createElement('input');
      inputEl.className = 'modal-input';
      inputEl.type = 'text';
      inputEl.value = input.value || '';
      box.appendChild(inputEl);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'modal-btn';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.className = 'modal-btn ' + (danger ? 'danger' : 'primary');
    confirm.textContent = confirmLabel || 'OK';
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    box.appendChild(actions);

    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    if (inputEl) {
      inputEl.focus();
      if (input.selectRange) {
        inputEl.setSelectionRange(input.selectRange[0], input.selectRange[1]);
      } else {
        inputEl.select();
      }
    } else {
      confirm.focus();
    }

    function close(value) {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); close(inputEl ? inputEl.value : true); }
    }
    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => close(inputEl ? inputEl.value : true));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(null); });
    document.addEventListener('keydown', onKey);
  });
}

// ===================================================================
// Easter egg — 遇事不决问春风~
// Random coin flip or dice roll, centered card, click anywhere to close.
// ===================================================================

// Dice — 18 sayings per face, themed around the number's symbolism.
const FORTUNE_DICE_SAYINGS = {
  1: [
    '一锤定音', '一往无前', '一鸣惊人', '一气呵成', '一帆风顺',
    '一举两得', '一夫当关', '独占鳌头', '一意孤行也无妨', '一个就够',
    '单枪匹马上', '万事开头难，但你能', '第一步迈出去', '孤注一掷', '一击必中',
    '一念之间', '一切刚刚好', '一切都来得及',
  ],
  2: [
    '好事成双', '双管齐下', '一举两得', '鱼与熊掌兼得', '两全其美',
    '二话不说，干', '进可攻退可守', '左右逢源', '两条路都通', '二人同心其利断金',
    '第二次机会来了', '别犹豫，二选一', '两手都要硬', '双喜临门', '二者必居其一',
    '两个选择，都行', '双倍幸运', '加倍奉还',
  ],
  3: [
    '三思后行', '三阳开泰', '事不过三', '三足鼎立', '三人行必有我师',
    '第三次试试，会成', '三天后再看', '三言两语说不清就行动', '三十六计走为上', '吾日三省吾身',
    '三生有幸', '三分天注定七分靠打拼', '三日不练手生', '一日不见如隔三秋', '三个臭皮匠顶一诸葛',
    '三月春风', '三两好友足矣', '三件事挑最重要的',
  ],
  4: [
    '四平八稳', '四通八达', '四海皆春', '安如磐石', '稳中求进',
    '四方来财', '四季常青', '一年四季都是好时节', '不偏不倚', '稳如老狗',
    '八面玲珑', '安然无恙', '心安四方', '四面来风', '四海为家',
    '站得稳走得远', '守正出奇', '不慌不忙',
  ],
  5: [
    '五福临门', '五星好评', '五彩缤纷', '五湖四海皆春', '五光十色',
    '五行俱足', '五马奔腾', '五体投地的运气', '五味俱全', '五子登科',
    '一举夺魁', '五星上将', '五颗星运势', '中五百万都不为过', '五年内必成',
    '满堂红', '福禄寿喜财', '五谷丰登',
  ],
  6: [
    '六六大顺', '顺风顺水', '一路绿灯', '六畜兴旺', '六合同春',
    '六根清净', '一切如愿', '时来运转', '旗开得胜', '万事顺意',
    '春风得意', '六字真言：随你心意', '一切顺遂', '心想事成', '大道至简',
    '顺势而为', '六亲不认地去做', '六六之运已到',
  ],
};

// Coin sides — 18 each. Heads leans into "go", tails leans into "wait".
const COIN_HEADS_SAYINGS = [
  '该出手时就出手',
  '干就完了',
  '现在就是好时机',
  '别犹豫，做',
  '直接上',
  '风顺，就走',
  '答应它',
  '大胆点',
  '你赢',
  '该 yes 的时候就 yes',
  '趁热打铁',
  '这步对了',
  '心动就行动',
  '这次靠谱',
  '没毛病，开干',
  '你说对的就是对的',
  '春风替你点了头',
  '冲',
];

const COIN_TAILS_SAYINGS = [
  '再想想吧',
  '缓一缓',
  '时机未到',
  '先放一放',
  '等等再说',
  '不急',
  '不必现在决定',
  '拒绝它',
  '再睡一觉看',
  '慢一点',
  '该 no 的时候就 no',
  '没风，别启航',
  '这次别勉强',
  '心里没底就别动',
  '不是时候',
  '让子弹再飞一会儿',
  '算了吧',
  '春风替你摇了头',
];

// Pip layout per face on a 3×3 grid. Standard western dice — opposite faces sum to 7.
const DICE_PIPS = {
  1: ['mc'],
  2: ['tl', 'br'],
  3: ['tl', 'mc', 'br'],
  4: ['tl', 'tr', 'bl', 'br'],
  5: ['tl', 'tr', 'mc', 'bl', 'br'],
  6: ['tl', 'ml', 'bl', 'tr', 'mr', 'br'],
};

// Face N → cube rotation that brings face N to the camera.
// Placement: 1 front, 2 right, 3 top, 4 bottom, 5 left, 6 back (1+6, 2+5, 3+4 opposite).
const DICE_FACE_TO_ROT = {
  1: { x: 0,   y: 0   },
  2: { x: 0,   y: -90 },
  3: { x: -90, y: 0   },
  4: { x: 90,  y: 0   },
  5: { x: 0,   y: 90  },
  6: { x: 0,   y: 180 },
};

// Lots — weighted toward the middle, mirroring an actual fortune-stick draw.
// Each tier carries 18 readings; pick one at random once the tier is drawn.
const FORTUNE_LOTS = [
  {
    tier: '上上签', weight: 1,
    sayings: [
      '万事顺心，今日好风扑面', '心想事成的一天', '桃花、贵人、好运齐到',
      '想做的都会成', '出门见喜', '满分上签',
      '春风得意马蹄疾', '一日看尽长安花', '锦上添花',
      '抬头三尺有神明', '福星高照', '紫气东来',
      '大吉大利', '鸿运当头', '阖家欢乐',
      '心愿成真', '好事自然来', '别怕，今天稳赢',
    ],
  },
  {
    tier: '上签', weight: 3,
    sayings: [
      '好风正起，沿着想做的事走', '努力会有回报', '该来的都会来',
      '一切都在变好', '顺水推舟', '守得云开见月明',
      '慢慢来都会有的', '你做的对', '拨云见日',
      '心安即是归处', '喜事将至', '春风正暖',
      '心情爽朗，事事顺利', '不急，正在路上', '你已在好转的路上',
      '好运还在路上', '努力会有回声', '该是你的跑不掉',
    ],
  },
  {
    tier: '中签', weight: 4,
    sayings: [
      '不急不躁，按部就班即可', '平平淡淡才是真', '别问结果，先做事',
      '不好不坏，刚刚好', '守着初心做就行', '维持现状也不错',
      '一切如常', '走得稳一点', '不上不下，刚好',
      '中规中矩', '平安即是福', '别折腾',
      '顺其自然', '稳一点', '守正待时',
      '当下足矣', '该来的会来', '平常心',
    ],
  },
  {
    tier: '下签', weight: 3,
    sayings: [
      '稳一点，今日不宜冒进', '三思而后行', '谨慎行事',
      '退一步海阔天空', '今日宜守', '不宜出远门',
      '不宜签字', '不宜表白', '凡事多忍让',
      '静观其变', '缓行', '不宜决断',
      '风太大，先归来', '这事儿先放一放', '今天先收一收',
      '量力而行', '别贪', '退也是一种进',
    ],
  },
  {
    tier: '下下签', weight: 1,
    sayings: [
      '今日先歇着，明日再战', '闭门思过', '大凶之兆，不出门为妙',
      '今天宜：什么都不做', '早点睡', '万事不宜',
      '今天的事留给明天', '别签、别买、别答应', '停',
      '退而结网', '来日再来', '春风不渡此关',
      '不动为吉', '大忌：争辩', '大忌：消费',
      '大忌：表态', '听别人的别听自己的', '装睡，最好',
    ],
  },
];

// 108 — 暗合佛家烦恼数；分八组写在源码里方便往后补，运行时仍是一只扁平数组。
const FORTUNE_SAYINGS = [
  // —— 原版 12 条 ——
  '今天的风很适合做决定',
  '想做的事就去做，别等春风过境',
  '事缓则圆，急事不要急办',
  '心里没底的事，先睡一觉再想',
  '问就是 yes',
  '问就是 no',
  '别问了，去做',
  '相信第一直觉',
  '坐下喝杯茶再说',
  '今日宜：摸鱼。今日忌：内耗',
  '没人催你，你自己别催自己',
  '差不多就行，别把它做完美',

  // —— 决断 ——
  '想清楚再动，比动了再想清楚省力',
  '你已经知道答案，只是想找个人附和',
  '不知道答案就先不动',
  '直觉错过两次，第三次就听它的',
  '二选一，选当下让你放松的那个',
  '列三条优先级，先做第一条',
  '删掉清单里最不想做的那条',
  '待办太多时，只保留三条',
  '别问值不值得，先做着',
  '把"以后再说"换成"现在做五分钟"',
  '写下来，问题就消了一半',
  '走着走着就清楚了',

  // —— 缓行 ——
  '慢慢来比较快',
  '越急越慢',
  '一次只做一件事',
  '让子弹再飞一会儿',
  '这事先放一放，让它发酵',
  '把它交给明天的自己',
  '三天后再回头看，你会笑',
  '这事儿，明年的你不会记得',
  '顺其自然，但要先尽人事',
  '尽人事，听天命',
  '该来的会来，该走的会走',
  '风会替你做决定，如果你愿意听',

  // —— 宜忌 ——
  '今日宜：发呆。今日忌：开会',
  '今日宜：散步。今日忌：刷手机',
  '今日宜：早睡。今日忌：emo',
  '今日宜：见朋友。今日忌：自我怀疑',
  '今日宜：动手做。今日忌：再等等',
  '今日宜：说"不"。今日忌：硬撑',
  '今日宜：说"是"。今日忌：再想想',
  '今日宜：留白。今日忌：填满',
  '今日宜：写字。今日忌：发消息',
  '今日宜：独处。今日忌：合群',
  '今日宜：复盘。今日忌：自责',
  '今日宜：放空。今日忌：纠结',

  // —— 自处 ——
  '你不是机器，可以休息',
  '你不是石头，可以改变主意',
  '改主意不是失败',
  '不做也是一种选择',
  '拒绝也是一种回答',
  '沉默不是逃避，是缓冲',
  '不必每个人都喜欢你',
  '不必每件事都做对',
  '错了就改，没什么大不了',
  '把自己当朋友劝一句',
  '别让"应该"压过"想要"',
  '也别让"想要"挤掉"必要"',

  // —— 行动 ——
  '行动比想象便宜',
  '完成大于完美',
  '60 分就交卷',
  '先做手上能立刻开始的那一步',
  '不必喜欢它，做完就行',
  '把手边的事先做完',
  '不必证明，做出来给他看',
  '别再开会了，去做吧',
  '出门走十分钟',
  '关掉通知，专心一会儿',
  '把手机扔远一点',
  '今日只做一件正事',

  // —— 时机 ——
  '今天不适合做大决定',
  '今天就是要做大决定的日子',
  '别在凌晨三点做选择',
  '别在周一早上下结论',
  '别在周五下午开新坑',
  '别空着肚子做决定',
  '答应之前，查一下日历',
  '在拒绝之前，再问自己一次',
  '在答应之前，再问自己一次',
  '这个想法值得保留，但不是现在',
  '时机比努力重要',
  '现在不是时候，但快了',

  // —— 生活 ——
  '抬头看看天',
  '听听窗外的风',
  '喝口水，再说',
  '喝口热的',
  '吃点东西再决定',
  '把窗户打开一会儿',
  '该上的班还是要上',
  '该请的假就请',
  '该躺平就躺平',
  '该卷的时候卷一下',
  '你已经做得不错了',
  '你今天已经够努力了',

  // —— 放下 ——
  '这事儿值得你皱眉吗',
  '把"为什么是我"换成"那就我吧"',
  '与其纠结过去，不如计划明天',
  '与其规划明天，不如先把今天过完',
  '道个歉，向前走',
  '已读不回也是一种态度',
  '别问春风，问自己',
  '答案在你心里，不在春风这儿',
  '不必每件事都有答案',
  '今天到此为止',
  '早点睡，明天有春风',
  '遇事不决，问春风',
];

function weightedPick(items) {
  const total = items.reduce((s, it) => s + (it.weight || 1), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= (it.weight || 1);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

const FORTUNE_TITLES = {
  coin:   '抛 · 硬 · 币',
  dice:   '摇 · 骰 · 子',
  lots:   '抽 · 签',
  saying: '春 · 风 · 一 · 句',
};

function showFortune(kind) {
  if (document.querySelector('.fortune-backdrop')) return; // already open
  if (!kind) kind = 'coin';

  const backdrop = document.createElement('div');
  backdrop.className = 'fortune-backdrop';

  const card = document.createElement('div');
  card.className = 'fortune-card';
  const title = FORTUNE_TITLES[kind] || '遇事不决问春风~';
  card.innerHTML =
    `<div class="fortune-title">${title}</div>` +
    '<div class="fortune-stage"></div>' +
    '<div class="fortune-result"></div>' +
    '<div class="fortune-hint">click anywhere to close</div>';
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);

  const stage = card.querySelector('.fortune-stage');
  const resultEl = card.querySelector('.fortune-result');
  const hintEl = card.querySelector('.fortune-hint');

  const runners = {
    coin:   runCoinFlip,
    dice:   runDiceRoll,
    lots:   runLotsDraw,
    saying: runSpringSaying,
  };
  const cancel = (runners[kind] || runners.coin)(stage, resultEl, hintEl);

  backdrop.addEventListener('click', () => {
    if (typeof cancel === 'function') cancel();
    backdrop.remove();
  });
}

// Reveal the result line and the dismiss hint after the spin settles.
function revealFortune(resultEl, hintEl, text) {
  resultEl.textContent = text;
  resultEl.classList.add('show');
  setTimeout(() => hintEl.classList.add('show'), 380);
}

// 3D coin flip: rotateX with translateY arc, settles on heads or tails.
function runCoinFlip(stage, resultEl, hintEl) {
  stage.innerHTML =
    '<div class="coin">' +
      '<div class="coin-face coin-front">正</div>' +
      '<div class="coin-face coin-back">反</div>' +
    '</div>' +
    '<div class="coin-shadow"></div>';

  const coin = stage.querySelector('.coin');
  const shadow = stage.querySelector('.coin-shadow');
  const heads = Math.random() < 0.5;
  const flips = 5 + Math.floor(Math.random() * 2);     // 5 or 6 full flips
  const endRot = flips * 360 + (heads ? 0 : 180);
  const peakLift = 60 + Math.floor(Math.random() * 12);

  const coinAnim = coin.animate(
    [
      { transform: 'translateY(0) rotateX(0deg)' },
      { transform: `translateY(-${peakLift}px) rotateX(${endRot * 0.5}deg)`, offset: 0.5 },
      { transform: `translateY(0) rotateX(${endRot}deg)` },
    ],
    {
      duration: 1300,
      easing: 'cubic-bezier(0.33, 0.06, 0.45, 1)',
      fill: 'forwards',
    }
  );

  // Shadow shrinks while the coin is at peak (further from "ground") then expands back.
  const shadowAnim = shadow.animate(
    [
      { transform: 'translateY(0) scale(1)', opacity: 0.32 },
      { transform: 'translateY(0) scale(0.55)', opacity: 0.14, offset: 0.5 },
      { transform: 'translateY(0) scale(1)', opacity: 0.32 },
    ],
    { duration: 1300, easing: 'ease-in-out', fill: 'forwards' }
  );

  const settle = setTimeout(() => {
    const pool = heads ? COIN_HEADS_SAYINGS : COIN_TAILS_SAYINGS;
    const saying = pool[Math.floor(Math.random() * pool.length)];
    revealFortune(resultEl, hintEl, `${heads ? '正面' : '反面'} · ${saying}`);
  }, 1300);

  return () => {
    clearTimeout(settle);
    coinAnim.cancel();
    shadowAnim.cancel();
  };
}

// 3D dice: build a real CSS cube with pips, hop + tumble on 3 axes, then land
// with a squash. The shadow shrinks at peak and rebounds on impact so the cube
// feels physically anchored to the surface.
function runDiceRoll(stage, resultEl, hintEl) {
  const cube = document.createElement('div');
  cube.className = 'dice-cube';
  for (let value = 1; value <= 6; value++) {
    const face = document.createElement('div');
    face.className = `dice-face dice-face-${value}`;
    for (const area of DICE_PIPS[value]) {
      const pip = document.createElement('span');
      pip.className = 'dice-pip';
      pip.style.gridArea = area;
      face.appendChild(pip);
    }
    cube.appendChild(face);
  }

  const wrap = document.createElement('div');
  wrap.className = 'dice-wrap';
  wrap.appendChild(cube);

  const shadow = document.createElement('div');
  shadow.className = 'dice-shadow';

  stage.appendChild(wrap);
  stage.appendChild(shadow);

  const n = Math.floor(Math.random() * 6) + 1;
  const target = DICE_FACE_TO_ROT[n];
  // Multiples of 360° on every axis so the cube lands exactly on the target
  // orientation no matter how chaotic the path between looks.
  const spinsX = 3 + Math.floor(Math.random() * 2);
  const spinsY = 4 + Math.floor(Math.random() * 2);
  const signZ  = Math.random() < 0.5 ? -1 : 1;
  const tx = spinsX * 360 + target.x;
  const ty = spinsY * 360 + target.y;
  const tz = (2 + Math.floor(Math.random() * 2)) * 360 * signZ;

  const tumbleMs = 1200;

  const tumbleAnim = cube.animate(
    [
      { transform: 'rotateX(0deg) rotateY(0deg) rotateZ(0deg)' },
      { transform: `rotateX(${tx}deg) rotateY(${ty}deg) rotateZ(${tz}deg)` },
    ],
    { duration: tumbleMs, easing: 'cubic-bezier(0.16, 0.6, 0.22, 1)', fill: 'forwards' }
  );

  // Subtle shadow pulse — denser at the start (motion blur) → settles steady.
  const shadowAnim = shadow.animate(
    [
      { transform: 'scale(1.08)', opacity: 0.5 },
      { transform: 'scale(1)',    opacity: 0.36 },
    ],
    { duration: tumbleMs, easing: 'ease-out', fill: 'forwards' }
  );

  const settle = setTimeout(() => {
    const pool = FORTUNE_DICE_SAYINGS[n] || [];
    const saying = pool[Math.floor(Math.random() * pool.length)] || '';
    revealFortune(resultEl, hintEl, `${n} 点 · ${saying}`);
  }, tumbleMs);

  return () => {
    clearTimeout(settle);
    tumbleAnim.cancel();
    shadowAnim.cancel();
  };
}

// 抽签 — bamboo tube shakes, then the chosen fortune stick rises out the top.
function runLotsDraw(stage, resultEl, hintEl) {
  const lot = weightedPick(FORTUNE_LOTS);

  const wrap = document.createElement('div');
  wrap.className = 'lots-wrap';
  wrap.innerHTML =
    '<div class="lots-tube">' +
      '<div class="lots-tube-rim"></div>' +
      '<div class="lots-tube-grain"></div>' +
      '<div class="lots-sticks">' +
        '<span style="height:22px"></span>' +
        '<span style="height:30px"></span>' +
        '<span style="height:26px"></span>' +
        '<span style="height:32px"></span>' +
        '<span style="height:24px"></span>' +
      '</div>' +
    '</div>' +
    '<div class="lots-result-stick"><span class="lots-result-text"></span></div>' +
    '<div class="lots-shadow"></div>';

  const tube = wrap.querySelector('.lots-tube');
  const resultStick = wrap.querySelector('.lots-result-stick');
  resultStick.querySelector('.lots-result-text').textContent = lot.tier;
  stage.appendChild(wrap);

  tube.classList.add('lots-shaking');

  const sayings = lot.sayings || (lot.msg ? [lot.msg] : ['']);
  const saying = sayings[Math.floor(Math.random() * sayings.length)];

  const settle = setTimeout(() => {
    tube.classList.remove('lots-shaking');
    resultStick.classList.add('show');
    revealFortune(resultEl, hintEl, saying);
  }, 950);

  return () => { clearTimeout(settle); };
}

// Drifting petals on a breeze — petals enter from the left, ride curving paths
// across the stage, and the saying surfaces as the last petal settles.
function runSpringSaying(stage, resultEl, hintEl) {
  const saying =
    FORTUNE_SAYINGS[Math.floor(Math.random() * FORTUNE_SAYINGS.length)];

  const scene = document.createElement('div');
  scene.className = 'breeze-scene';
  scene.innerHTML =
    '<div class="breeze-wisp breeze-wisp-1"></div>' +
    '<div class="breeze-wisp breeze-wisp-2"></div>' +
    '<div class="breeze-wisp breeze-wisp-3"></div>';
  stage.appendChild(scene);

  const PETAL_GLYPHS = ['❀', '✿', '❁', '✾', '❀', '✿'];
  const PETAL_COLORS = ['#f7a6c1', '#f48fb1', '#fbc4d3', '#ef9bb6', '#f9c8d6', '#e58fae'];
  const PETAL_COUNT = 7;
  const anims = [];

  for (let i = 0; i < PETAL_COUNT; i++) {
    const p = document.createElement('span');
    p.className = 'breeze-petal';
    p.textContent = PETAL_GLYPHS[i % PETAL_GLYPHS.length];
    p.style.color = PETAL_COLORS[i % PETAL_COLORS.length];
    p.style.fontSize = `${14 + Math.random() * 12}px`;
    scene.appendChild(p);

    const startY = 6 + Math.random() * 84;
    const drift  = 12 + Math.random() * 26;
    const dur    = 1900 + Math.random() * 700;
    const delay  = i * 100 + Math.random() * 90;
    const spin   = (Math.random() < 0.5 ? -1 : 1) * (320 + Math.random() * 280);

    const a = p.animate(
      [
        { transform: `translate(-44px, ${startY}px) rotate(0deg)`,                                opacity: 0 },
        { transform: `translate(60px,  ${startY - drift}px) rotate(${spin * 0.35}deg)`,           opacity: 1,    offset: 0.32 },
        { transform: `translate(170px, ${startY + drift * 0.55}px) rotate(${spin * 0.7}deg)`,     opacity: 0.95, offset: 0.68 },
        { transform: `translate(290px, ${startY - drift * 0.45}px) rotate(${spin}deg)`,           opacity: 0 },
      ],
      { duration: dur, delay, easing: 'cubic-bezier(0.45, 0.02, 0.55, 0.98)', fill: 'forwards' }
    );
    anims.push(a);
  }

  resultEl.classList.add('breeze-result');
  const settle = setTimeout(() => {
    revealFortune(resultEl, hintEl, saying);
  }, 1280);

  return () => {
    clearTimeout(settle);
    anims.forEach((a) => a.cancel());
  };
}

function showToast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 200);
  }, 2200);
}

// Public API exposed to the host (Swift evaluateJavaScript / Tauri events).
window.MDViewerAPI = {
  render,
  setTheme,
  scrollToAnchor,
  setFileTree: (payload) => Sidebar.setFileTree(payload),
  toast: (message, type) => showToast(message, type),
  selectAllContent,
  toggleSidebar: () => Sidebar.toggleCollapsed(),
};
