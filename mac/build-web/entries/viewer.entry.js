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
  // Hide the "Open a file" placeholder while a load is in flight, so the
  // dots aren't fighting with the empty-state glyph in the same space.
  const loading = document.getElementById('main')?.classList.contains('is-loading');
  empty.hidden = loading || root.children.length > 0;
}

// Loading indicator — shown after a short delay so fast reads don't flicker
// a spinner on screen. Cancelled the moment `render()` runs or `setLoading(false)`
// is called explicitly by the host. A safety timeout auto-clears the indicator
// if the host never reports back (e.g. native dedupes the load).
let loadingShowTimer = null;
let loadingSafetyTimer = null;
function setLoading(visible) {
  const main = document.getElementById('main');
  const node = document.getElementById('loading-state');
  if (!main || !node) return;
  if (loadingShowTimer) {
    clearTimeout(loadingShowTimer);
    loadingShowTimer = null;
  }
  if (loadingSafetyTimer) {
    clearTimeout(loadingSafetyTimer);
    loadingSafetyTimer = null;
  }
  if (visible) {
    // 80ms grace — anything that resolves faster won't trigger the indicator.
    loadingShowTimer = setTimeout(() => {
      loadingShowTimer = null;
      main.classList.add('is-loading');
      node.hidden = false;
      // Force layout so the opacity transition runs on the next frame.
      void node.offsetWidth;
      node.classList.add('is-visible');
      updateEmptyState();
    }, 80);
    // If no render() arrives within 8s, give up rather than stranding the UI.
    loadingSafetyTimer = setTimeout(() => {
      loadingSafetyTimer = null;
      setLoading(false);
    }, 8000);
  } else {
    main.classList.remove('is-loading');
    node.classList.remove('is-visible');
    // Wait out the fade-out before hiding so the dots don't pop.
    setTimeout(() => {
      if (!main.classList.contains('is-loading')) node.hidden = true;
    }, 220);
    updateEmptyState();
  }
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
  setLoading(false);
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
  setLoading(true);
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

// Pending lazy-folder scans — reqId → path, plus the set of folder paths
// currently waiting on a host response (drives the inline spinner).
const pendingScans = new Map();
const loadingDirs = new Set();
let scanSeq = 0;

function requestScanDir(path) {
  const reqId = `sd-${Date.now().toString(36)}-${(++scanSeq).toString(36)}`;
  pendingScans.set(reqId, path);
  loadingDirs.add(path);
  try {
    if (window.webkit?.messageHandlers?.scanDir) {
      window.webkit.messageHandlers.scanDir.postMessage({ path, reqId });
      return;
    }
  } catch {}
  try {
    const ev = window.__TAURI__?.event;
    if (ev && typeof ev.emit === 'function') {
      ev.emit('mdreader:scan-dir', { path, reqId });
      return;
    }
  } catch {}
  // No host bridge available — drop the spinner so the UI doesn't hang.
  pendingScans.delete(reqId);
  loadingDirs.delete(path);
}

const Sidebar = (() => {
  let currentTree = null;        // { root, current }
  let currentOutline = [];
  const expanded = new Set();    // paths of expanded dirs
  let lastTreeKey = '';          // memoize tree shape so re-renders are cheap
  // Lazy folders (node_modules, dist, …) come back from the host as stubs
  // every time the tree is re-pushed. Once the user has expanded one, cache
  // its children here so subsequent setFileTree() calls can re-hydrate the
  // stub — otherwise opening an md inside such a folder would collapse it.
  const scannedDirs = new Map();
  let currentRootPath = '';
  let currentThemePref = 'system';
  // Native hosts still push recents via MDViewerAPI.setRecents — held here in
  // case a UI is reintroduced; nothing renders them today.
  let currentRecents = [];

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
    // Fresh users (no localStorage entry) fall back to dark.
    setThemePref(localStorage.getItem('mdreader.theme.pref') || 'dark');

    // Stamp the bundle's package version into the sidebar footer. The literal
    // is injected by esbuild's `define` (see build.mjs); falls back gracefully
    // if someone runs the source outside the bundle.
    const ver = el('sb-version');
    if (ver) {
      const v = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
      ver.textContent = v ? `v${v}` : '';
    }

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
    if (currentTree?.root) {
      // If the workspace root changed, the cached lazy-dir contents from the
      // previous workspace are stale.
      if (currentTree.root.path !== currentRootPath) {
        scannedDirs.clear();
        currentRootPath = currentTree.root.path;
      }
      // Re-hydrate any lazy nodes whose children we previously scanned, so
      // the host's "lazy stub" doesn't collapse a folder the user expanded.
      walk(currentTree.root, (node) => {
        if (node.type === 'dir' && node.lazy && scannedDirs.has(node.path)) {
          node.children = scannedDirs.get(node.path);
          node.lazy = false;
        }
      });
    }
    autoExpand();
    renderFiles();
  }

  function onScanDirResult(reqId, payload) {
    const path = pendingScans.get(reqId);
    if (!path) return;
    pendingScans.delete(reqId);
    loadingDirs.delete(path);
    if (!currentTree?.root || !payload) {
      renderFiles();
      return;
    }
    const targetPath = payload.path || path;
    const children = Array.isArray(payload.children) ? payload.children : [];
    walk(currentTree.root, (node) => {
      if (node.type === 'dir' && node.path === targetPath) {
        node.children = children;
        node.lazy = false;
      }
    });
    scannedDirs.set(targetPath, children);
    // Keep memo in sync so a later auto-expand doesn't wipe what we just
    // loaded.
    lastTreeKey = treeKey(currentTree.root);
    renderFiles();
  }

  function setOutline(items) {
    currentOutline = Array.isArray(items) ? items : [];
    renderOutline();
  }

  // No-op holder. The visible Recent files menu was removed; the native
  // side still tracks recents and pushes them here, so reintroducing a UI
  // later (right-click, command palette, …) just needs to read this list.
  function setRecents(list) {
    currentRecents = Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
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
      const isLazy = !!node.lazy;
      const isLoading = loadingDirs.has(node.path);
      const open = expanded.has(node.path);
      if (isLoading) {
        toggle.textContent = '';
        toggle.classList.add('tree-spinner');
      } else {
        toggle.textContent = open ? '▾' : '▸';
      }
      row.appendChild(toggle);
      row.appendChild(label);
      if (isLazy && !isLoading) {
        const hint = document.createElement('span');
        hint.className = 'tree-lazy-hint';
        hint.textContent = '…';
        hint.title = 'Click to load';
        row.appendChild(hint);
      }
      row.addEventListener('click', () => {
        if (isLoading) return;
        if (isLazy) {
          // Treat first click as "load + open" — show spinner immediately
          // and mark expanded so the result drops in already open.
          expanded.add(node.path);
          requestScanDir(node.path);
          renderFiles();
          return;
        }
        if (expanded.has(node.path)) expanded.delete(node.path);
        else expanded.add(node.path);
        renderFiles();
      });
      wrap.appendChild(row);
      if (open && !isLazy && node.children?.length) {
        const kids = document.createElement('div');
        kids.className = 'tree-children';
        for (const c of node.children) kids.appendChild(buildNode(c, current));
        wrap.appendChild(kids);
      }
    } else {
      toggle.textContent = '';
      row.appendChild(toggle);
      row.appendChild(label);
      row.addEventListener('click', () => {
        // Re-clicking the active file: native shells de-dupe the load (no
        // re-render fires), which would strand the loader. Just scroll the
        // doc to the top, mirroring what most editors do for the same case.
        if (node.path === current) {
          const main = document.getElementById('main');
          if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        requestOpenFile(node.path);
      });
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
        { label: 'New File…',   action: () => promptCreate(node, 'file') },
        { label: 'New Folder…', action: () => promptCreate(node, 'folder') },
        'separator',
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

  return {
    init,
    setFileTree,
    setOutline,
    setThemePref,
    toggleCollapsed,
    onScanDirResult,
    setRecents,
  };
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

async function promptCreate(parentDir, kind) {
  const placeholder = kind === 'file' ? 'untitled.md' : 'new-folder';
  const stemEnd = kind === 'file' && placeholder.lastIndexOf('.') > 0
    ? placeholder.lastIndexOf('.')
    : placeholder.length;
  const v = await showModal({
    title: kind === 'file' ? 'New File' : 'New Folder',
    input: { value: placeholder, selectRange: [0, stemEnd] },
    confirmLabel: 'Create',
  });
  if (typeof v !== 'string') return;
  const name = v.trim();
  if (!name) return;
  if (/[\\/]/.test(name)) {
    showToast('Name cannot contain / or \\', 'error');
    return;
  }
  fsOp({
    op: kind === 'file' ? 'newFile' : 'newFolder',
    path: parentDir.path,
    newName: name,
  });
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
// CSS y-axis points down, so .dice-face-3 (rotateX(-90)) is on the bottom and
// .dice-face-4 (rotateX(+90)) is on the top — invert the X angles to bring
// each face's outward normal to +Z. Opposite pairs still sum to 7.
const DICE_FACE_TO_ROT = {
  1: { x: 0,   y: 0   },
  2: { x: 0,   y: -90 },
  3: { x: 90,  y: 0   },
  4: { x: -90, y: 0   },
  5: { x: 0,   y: 90  },
  6: { x: 0,   y: 180 },
};

// Lots — weighted toward the middle, mirroring an actual fortune-stick draw.
// Each tier carries 18 readings; pick one at random once the tier is drawn.
// Weights tuned so 上 > 中 > 下 — the tube tilts good. 上上 / 下下 stay rare.
//   上上=2  上=6  中=4  下=2  下下=1   →  53% 上+上上 / 27% 中 / 20% 下+下下
// Each tier carries an `interps` pool: today's fortune in plain language,
// always with a positive lean — even 下下 reads as "rest now, things will turn".
const FORTUNE_LOTS = [
  {
    tier: '上上签', weight: 2,
    sayings: [
      '万事顺心，今日好风扑面', '心想事成的一天', '桃花、贵人、好运齐到',
      '想做的都会成', '出门见喜', '满分上签',
      '春风得意马蹄疾', '一日看尽长安花', '锦上添花',
      '抬头三尺有神明', '福星高照', '紫气东来',
      '大吉大利', '鸿运当头', '阖家欢乐',
      '心愿成真', '好事自然来', '别怕，今天稳赢',
    ],
    interps: [
      '今日运势：诸事皆顺，做什么都有人接住',
      '今日运势：满分天，财运、桃花、贵人都站你这边',
      '今日运势：心想事成，记得把这份福气收下',
      '今日运势：抬头是阳光，低头是顺风，开干就完事',
      '今日运势：别犹豫，今天的运气配额特别足',
      '今日运势：连堵车都让路，到哪都不会被卡住',
      '今日运势：出门见喜，回家见礼',
      '今日运势：所求皆得，所愿皆成',
    ],
  },
  {
    tier: '上签', weight: 6,
    sayings: [
      '好风正起，沿着想做的事走', '努力会有回报', '该来的都会来',
      '一切都在变好', '顺水推舟', '守得云开见月明',
      '慢慢来都会有的', '你做的对', '拨云见日',
      '心安即是归处', '喜事将至', '春风正暖',
      '心情爽朗，事事顺利', '不急，正在路上', '你已在好转的路上',
      '好运还在路上', '努力会有回声', '该是你的跑不掉',
    ],
    interps: [
      '今日运势：风正起，事顺心，去做想做的事就好',
      '今日运势：付出会被看见，等的人也快到了',
      '今日运势：好事一件接一件，留点期待感',
      '今日运势：心情松了，事情自然就顺了',
      '今日运势：贵人在身边，多说几句没坏处',
      '今日运势：手头的事会有进展，别急',
      '今日运势：今天适合往前走一小步',
      '今日运势：好运在路上，再耐心一点',
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
    interps: [
      '今日运势：稳，按部就班来就好',
      '今日运势：无大喜也无大悲，舒服一天',
      '今日运势：把今天平平稳稳过完就是赢',
      '今日运势：维持现状是上策，明天再图变化',
      '今日运势：日子刚刚好，别加戏',
      '今日运势：守得住就有小收获',
      '今日运势：不咸不淡，做完手上的事就够',
      '今日运势：今天适合静下心，不必折腾',
    ],
  },
  {
    tier: '下签', weight: 2,
    sayings: [
      '稳一点，今日不宜冒进', '三思而后行', '谨慎行事',
      '退一步海阔天空', '今日宜守', '不宜出远门',
      '不宜签字', '不宜表白', '凡事多忍让',
      '静观其变', '缓行', '不宜决断',
      '风太大，先归来', '这事儿先放一放', '今天先收一收',
      '量力而行', '别贪', '退也是一种进',
    ],
    interps: [
      '今日运势：风有点大，今天先歇歇，明天会放晴',
      '今日运势：小事别上心，大事缓一缓',
      '今日运势：今天宜静，运气会在明天悄悄回来',
      '今日运势：少说少做，把麻烦攒到明天一起处理',
      '今日运势：今天累的，明天会双倍补给你',
      '今日运势：不顺只是暂时的，下午会好转',
      '今日运势：今日宜守，明日宜攻',
      '今日运势：少决策、多观察，运气在调整方向',
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
    interps: [
      '今日运势：今天先歇着，明天就有春风',
      '今日运势：糟心事到此为止，明天重新开始',
      '今日运势：今日宜：装睡。明日宜：重启',
      '今日运势：哪有什么下下签，只是提醒你早点睡',
      '今日运势：今天宇宙在测试你，过了就是大涨',
      '今日运势：歇一歇，运气在路上充电',
      '今日运势：闭门一日，明日开运',
      '今日运势：今天的负能量，睡一觉就清零',
    ],
  },
];

// 1..100 → 一..一百 in plain Chinese numerals (for stick numbers).
// Temple-stick numerals — uses 廿 (20s) and 卅 (30s) like real fortune sticks.
function toChineseNum(n) {
  const d = ['零','一','二','三','四','五','六','七','八','九'];
  if (n <= 0) return d[0];
  if (n < 10) return d[n];
  if (n === 100) return '百';
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  if (tens === 1) return ones === 0 ? '十' : '十' + d[ones];
  if (tens === 2) return ones === 0 ? '廿' : '廿' + d[ones];
  if (tens === 3) return ones === 0 ? '卅' : '卅' + d[ones];
  if (ones === 0) return d[tens] + '十';
  return d[tens] + '十' + d[ones];
}

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
  if (document.querySelector('.fortune-overlay')) return; // already open
  switch (kind) {
    case 'dice':   return stageDiceRoll();
    case 'lots':   return stageLotsDraw();
    case 'saying': return stageSpringSaying();
    case 'coin':
    default:       return stageCoinFlip();
  }
}

// Per-kind overlay shell. The overlay catches background clicks unless a child
// stops propagation. Each stager pushes its WAAPI animations / timers into
// `cancellers` so close() tears them down cleanly.
function buildFortuneOverlay(kind) {
  const overlay = document.createElement('div');
  overlay.className = 'fortune-overlay';
  overlay.setAttribute('data-kind', kind);
  document.body.appendChild(overlay);

  const cancellers = [];
  function close() {
    cancellers.forEach((fn) => { try { fn(); } catch {} });
    overlay.remove();
  }
  return { overlay, close, cancellers };
}

// Render `text` into `el` glyph by glyph — each character fades + un-blurs in,
// like ink reaching the page. Used for lots / saying reveals.
function inkWrite(el, text, opts) {
  const o = opts || {};
  const delayPer = o.delayPer != null ? o.delayPer : 80;
  const startDelay = o.startDelay != null ? o.startDelay : 0;
  const charDur = o.charDur != null ? o.charDur : 240;
  el.textContent = '';
  const chars = Array.from(text);
  const anims = [];
  chars.forEach((c, i) => {
    const s = document.createElement('span');
    s.className = 'ink-char';
    s.textContent = c === ' ' ? ' ' : c;
    s.style.opacity = '0';
    el.appendChild(s);
    const a = s.animate(
      [
        { opacity: 0, transform: 'translateY(5px) scale(1.06)', filter: 'blur(1.5px)' },
        { opacity: 1, transform: 'translateY(0) scale(1)',     filter: 'blur(0)'    },
      ],
      { duration: charDur, delay: startDelay + i * delayPer, easing: 'ease-out', fill: 'forwards' }
    );
    anims.push(a);
  });
  return {
    totalMs: startDelay + chars.length * delayPer + charDur,
    cancel: () => anims.forEach((a) => { try { a.cancel(); } catch {} }),
  };
}

// Reveal the result line + dismiss hint, styled to the kind: coin stamps in,
// dice shakes, lots and saying write stroke by stroke.
function revealFortune(resultEl, hintEl, text, kind) {
  resultEl.classList.add('show');
  if (kind === 'lots' || kind === 'saying') {
    const out = inkWrite(resultEl, text, { delayPer: 80, charDur: 240 });
    setTimeout(() => hintEl.classList.add('show'), Math.max(380, out.totalMs - 240));
    return;
  }
  resultEl.textContent = text;
  if (kind === 'dice') {
    resultEl.animate(
      [
        { opacity: 0, transform: 'translateX(0)' },
        { opacity: 1, transform: 'translateX(-6px)', offset: 0.25 },
        { opacity: 1, transform: 'translateX(5px)',  offset: 0.5  },
        { opacity: 1, transform: 'translateX(-3px)', offset: 0.75 },
        { opacity: 1, transform: 'translateX(0)' },
      ],
      { duration: 520, easing: 'cubic-bezier(0.45, 0, 0.3, 1)', fill: 'forwards' }
    );
  } else {
    // coin — stamp.
    resultEl.animate(
      [
        { opacity: 0, transform: 'translateY(12px) scale(1.08)', letterSpacing: '0.32em' },
        { opacity: 1, transform: 'translateY(0) scale(1)',       letterSpacing: '0.04em' },
      ],
      { duration: 400, easing: 'cubic-bezier(0.16, 1.2, 0.36, 1)', fill: 'forwards' }
    );
  }
  setTimeout(() => hintEl.classList.add('show'), 380);
}

// === Coin: flies from the sidebar ❀ button into the card stage, lands, ripples. ===
function stageCoinFlip() {
  const { overlay, close, cancellers } = buildFortuneOverlay('coin');

  const card = document.createElement('div');
  card.className = 'fortune-card';
  card.innerHTML =
    '<div class="fortune-title">抛 · 硬 · 币</div>' +
    '<div class="fortune-stage"></div>' +
    '<div class="fortune-result"></div>' +
    '<div class="fortune-hint">再 点 散 场</div>';
  overlay.appendChild(card);

  const stage = card.querySelector('.fortune-stage');
  const resultEl = card.querySelector('.fortune-result');
  const hintEl = card.querySelector('.fortune-hint');

  const heads = Math.random() < 0.5;
  const flips = 5 + Math.floor(Math.random() * 2);
  const endRot = flips * 360 + (heads ? 0 : 180);

  const flyer = document.createElement('div');
  flyer.className = 'coin-flyer';
  flyer.innerHTML =
    '<div class="coin">' +
      '<div class="coin-face coin-front">正</div>' +
      '<div class="coin-face coin-back">反</div>' +
    '</div>' +
    '<div class="coin-ripple"></div>';
  overlay.appendChild(flyer);

  // Layout-dependent coords come after the card has been laid out.
  requestAnimationFrame(() => {
    const btn = document.getElementById('sb-fortune-btn');
    let bx, by;
    if (btn) {
      const r = btn.getBoundingClientRect();
      bx = r.left + r.width / 2;
      by = r.top + r.height / 2;
    }
    if (!bx || !by) {
      bx = window.innerWidth / 2;
      by = window.innerHeight - 80;
    }
    const sr = stage.getBoundingClientRect();
    const tx = sr.left + sr.width / 2;
    const ty = sr.top + sr.height / 2;

    flyer.style.left = bx + 'px';
    flyer.style.top  = by + 'px';

    const dx = tx - bx;
    const dy = ty - by;
    const midX = dx / 2;
    const midY = Math.min(0, dy) - 160; // arc peak

    // Translate + scale animate the flyer (no 3D needed). The rotateX flip
    // must live on .coin (which has transform-style: preserve-3d) so the two
    // faces' backface-visibility actually does its job — otherwise the flyer's
    // rotation flattens .coin to 2D first and you end up seeing an upside-down
    // "正" instead of the "反" you'd expect.
    const flyAnim = flyer.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.45)' },
        { transform: `translate(calc(-50% + ${midX}px), calc(-50% + ${midY}px)) scale(0.85)`,        offset: 0.5  },
        { transform: `translate(calc(-50% + ${dx}px),   calc(-50% + ${dy - 8}px)) scale(1)`,         offset: 0.86 },
        { transform: `translate(calc(-50% + ${dx}px),   calc(-50% + ${dy + 2}px)) scale(1.06, 0.92)`, offset: 0.94 },
        { transform: `translate(calc(-50% + ${dx}px),   calc(-50% + ${dy}px))     scale(1)`           },
      ],
      { duration: 1150, easing: 'cubic-bezier(0.33, 0.06, 0.45, 1.05)', fill: 'forwards' }
    );
    cancellers.push(() => { try { flyAnim.cancel(); } catch {} });

    const coin = flyer.querySelector('.coin');
    const flipAnim = coin.animate(
      [
        { transform: 'rotateX(0deg)' },
        { transform: `rotateX(${endRot * 0.45}deg)`, offset: 0.5  },
        { transform: `rotateX(${endRot}deg)`,        offset: 0.86 },
        { transform: `rotateX(${endRot}deg)`,        offset: 1    },
      ],
      { duration: 1150, easing: 'cubic-bezier(0.33, 0.06, 0.45, 1.05)', fill: 'forwards' }
    );
    cancellers.push(() => { try { flipAnim.cancel(); } catch {} });

    const ripple = flyer.querySelector('.coin-ripple');
    const land = setTimeout(() => {
      const ra = ripple.animate(
        [
          { opacity: 0.65, transform: 'translate(-50%, -50%) scale(0.35)' },
          { opacity: 0,    transform: 'translate(-50%, -50%) scale(2.8)' },
        ],
        { duration: 560, easing: 'ease-out', fill: 'forwards' }
      );
      cancellers.push(() => { try { ra.cancel(); } catch {} });

      const pool = heads ? COIN_HEADS_SAYINGS : COIN_TAILS_SAYINGS;
      const saying = pool[Math.floor(Math.random() * pool.length)];
      revealFortune(resultEl, hintEl, `${heads ? '正面' : '反面'} · ${saying}`, 'coin');
    }, 1100);
    cancellers.push(() => clearTimeout(land));
  });

  overlay.addEventListener('click', close);
}

// Scatter `count` short-lived dust motes radially from the dice's landing
// point. Each mote is absolutely positioned in `stage` and self-removes when
// its animation ends; if the overlay closes early, removing `stage` cancels
// the WAAPI handles automatically.
function spawnDust(stage, count) {
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'dice-dust';
    stage.appendChild(p);
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.6;
    const dist = 22 + Math.random() * 24;
    const dx = Math.cos(angle) * dist;
    // Bias upward arc so motes don't sink — feels like ground dust kicked up.
    const dy = -Math.abs(Math.sin(angle)) * dist * 0.45 + 3;
    const dur = 420 + Math.random() * 220;
    const a = p.animate(
      [
        { transform: 'translate(-50%, 0)                            scale(1)',    opacity: 0.85 },
        { transform: `translate(calc(-50% + ${dx}px), ${dy}px) scale(0.25)`, opacity: 0    },
      ],
      { duration: dur, easing: 'cubic-bezier(0.2, 0.7, 0.4, 1)', fill: 'forwards' }
    );
    a.onfinish = () => p.remove();
  }
}

// === Dice: in-content infinite tumble. Click / Space / Enter to stop; Esc dismisses. ===
function stageDiceRoll() {
  const { overlay, close, cancellers } = buildFortuneOverlay('dice');

  // Stage holds the cube + its ground shadow so the shadow can stay anchored
  // while the cube bobs above it.
  const stage = document.createElement('div');
  stage.className = 'dice-stage';
  overlay.appendChild(stage);

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

  const cubeWrap = document.createElement('div');
  cubeWrap.className = 'dice-wrap dice-wrap-free';
  cubeWrap.appendChild(cube);
  stage.appendChild(cubeWrap);

  const shadow = document.createElement('div');
  shadow.className = 'dice-shadow';
  stage.appendChild(shadow);

  const prompt = document.createElement('div');
  prompt.className = 'dice-prompt';
  prompt.textContent = '点  击  停  止';
  overlay.appendChild(prompt);

  // Entrance: cube drops in from above with a small overshoot. Spin starts
  // immediately on the cube; the wrap-level bob waits for entrance to finish
  // so the two cubeWrap animations don't fight.
  const ENTER_MS = 360;
  const enterAnim = cubeWrap.animate(
    [
      { transform: 'translateY(-42px) scale(0.45)', opacity: 0.4 },
      { transform: 'translateY(2px)   scale(1.06)', opacity: 1,   offset: 0.7 },
      { transform: 'translateY(0px)   scale(1)',    opacity: 1,   offset: 1   },
    ],
    { duration: ENTER_MS, easing: 'cubic-bezier(0.34, 1.3, 0.5, 1)', fill: 'forwards' }
  );
  cancellers.push(() => { try { enterAnim.cancel(); } catch {} });

  // Tumble. Non-commensurate axis ratios + faster cycle so it whirs instead
  // of marching. WAAPI (not CSS keyframes) lets us read the animation's
  // progress at stop time and continue smoothly into the settle anim.
  const CYCLE = 1800;
  const rateX = 1.4, rateY = 1.85, rateZ = 0.83;
  const spinAnim = cube.animate(
    [
      { transform: 'rotateX(0deg) rotateY(0deg) rotateZ(0deg)' },
      { transform: `rotateX(${360 * rateX}deg) rotateY(${360 * rateY}deg) rotateZ(${360 * rateZ}deg)` },
    ],
    { duration: CYCLE, iterations: Infinity, easing: 'linear' }
  );
  cancellers.push(() => { try { spinAnim.cancel(); } catch {} });

  // Gentle bob + faint sway — sells the "tossed in palm" feel. Sway period
  // is intentionally off from bob so the motion never repeats cleanly.
  const bobAnim = cubeWrap.animate(
    [
      { transform: 'translate(0px,  0px)' },
      { transform: 'translate(1.5px, -6px)', offset: 0.5 },
      { transform: 'translate(-1px, 0px)',   offset: 1   },
    ],
    { duration: 1500, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', delay: ENTER_MS }
  );
  cancellers.push(() => { try { bobAnim.cancel(); } catch {} });
  const shadowAnim = shadow.animate(
    [
      { transform: 'translateX(-50%) scale(1, 1)',    opacity: 0.55 },
      { transform: 'translateX(-50%) scale(0.74, 1)', opacity: 0.30 },
      { transform: 'translateX(-50%) scale(1, 1)',    opacity: 0.55 },
    ],
    { duration: 1500, iterations: Infinity, easing: 'ease-in-out', delay: ENTER_MS }
  );
  cancellers.push(() => { try { shadowAnim.cancel(); } catch {} });

  let phase = 'spinning'; // → 'stopping' → 'shown'
  const startedAt = performance.now();
  // Wait until entrance settles so a stop never freezes mid-drop-in. Also
  // shrugs off the trailing mouseup from the menu click that opened us.
  const INPUT_LOCKOUT_MS = ENTER_MS + 40;

  // pickSettle: from `cur` angle, advance to a multiple of 360 plus the face
  // target offset, with at least one extra full rotation for visual settle.
  function pickSettle(cur, targetMod) {
    const t = ((targetMod % 360) + 360) % 360;
    const curMod = ((cur % 360) + 360) % 360;
    let delta = t - curMod;
    if (delta < 0) delta += 360;
    return cur + delta + 360;
  }

  function tryStop() {
    if (phase !== 'spinning') return;
    if (performance.now() - startedAt < INPUT_LOCKOUT_MS) return;
    phase = 'stopping';

    const t = (spinAnim.currentTime || 0) % CYCLE;
    const progress = t / CYCLE;
    const curX = 360 * rateX * progress;
    const curY = 360 * rateY * progress;
    const curZ = 360 * rateZ * progress;
    try { spinAnim.cancel(); } catch {}
    try { bobAnim.cancel(); } catch {}
    try { shadowAnim.cancel(); } catch {}

    const n = 1 + Math.floor(Math.random() * 6);
    const target = DICE_FACE_TO_ROT[n];
    const settleX = pickSettle(curX, target.x);
    const settleY = pickSettle(curY, target.y);
    const settleZ = pickSettle(curZ, 0);

    const STOP_MS = 780;
    const stopAnim = cube.animate(
      [
        { transform: `rotateX(${curX}deg) rotateY(${curY}deg) rotateZ(${curZ}deg)` },
        { transform: `rotateX(${settleX}deg) rotateY(${settleY}deg) rotateZ(${settleZ}deg)` },
      ],
      { duration: STOP_MS, easing: 'cubic-bezier(0.18, 0.6, 0.22, 1)', fill: 'forwards' }
    );
    cancellers.push(() => { try { stopAnim.cancel(); } catch {} });

    // Drop + impact squash + rebound, baked into a single animation on the wrap
    // so we never have two transforms fighting on the same element.
    const dropAnim = cubeWrap.animate(
      [
        { transform: 'translateY(-5px) scale(1, 1)',       offset: 0    },
        { transform: 'translateY(0px)  scale(1, 1)',       offset: 0.55 },
        { transform: 'translateY(2px)  scale(1.12, 0.84)', offset: 0.68 },
        { transform: 'translateY(0px)  scale(0.96, 1.06)', offset: 0.82 },
        { transform: 'translateY(0px)  scale(1, 1)',       offset: 1    },
      ],
      { duration: STOP_MS, easing: 'cubic-bezier(0.35, 0.05, 0.2, 1)', fill: 'forwards' }
    );
    cancellers.push(() => { try { dropAnim.cancel(); } catch {} });

    // Shadow sharpens + darkens as the cube lands.
    const shadowSettle = shadow.animate(
      [
        { transform: 'translateX(-50%) scale(0.78, 1)', opacity: 0.32, filter: 'blur(6px)' },
        { transform: 'translateX(-50%) scale(1.12, 1)', opacity: 0.62, filter: 'blur(3px)' },
      ],
      { duration: STOP_MS, easing: 'cubic-bezier(0.35, 0.05, 0.2, 1)', fill: 'forwards' }
    );
    cancellers.push(() => { try { shadowSettle.cancel(); } catch {} });

    prompt.classList.add('hide');

    // Impact: stage rumble + scattered dust right when squash hits its peak.
    // Squash peaks at offset 0.68 of STOP_MS.
    const impactDelay = Math.round(STOP_MS * 0.68);
    const impact = setTimeout(() => {
      const rumble = stage.animate(
        [
          { transform: 'translate(0, 0)' },
          { transform: 'translate(1.5px, -1px)', offset: 0.18 },
          { transform: 'translate(-1.5px, 1px)', offset: 0.42 },
          { transform: 'translate(0.8px, 0)',    offset: 0.66 },
          { transform: 'translate(-0.6px, 0)',   offset: 0.84 },
          { transform: 'translate(0, 0)',        offset: 1    },
        ],
        { duration: 220, easing: 'linear', fill: 'forwards' }
      );
      cancellers.push(() => { try { rumble.cancel(); } catch {} });
      spawnDust(stage, 8);
    }, impactDelay);
    cancellers.push(() => clearTimeout(impact));

    // After settle, lift the cube up so the result card flows in below. The
    // dice face itself reveals N — no separate numeric badge needed. A small
    // Z-tilt makes the lift feel like the die is being held up for display.
    const reveal = setTimeout(() => {
      const lift = cubeWrap.animate(
        [
          { transform: 'translateY(0)     scale(1)    rotate(0deg)' },
          { transform: 'translateY(-32px) scale(0.68) rotate(-7deg)' },
        ],
        { duration: 380, easing: 'cubic-bezier(0.33, 0, 0.4, 1)', fill: 'forwards' }
      );
      cancellers.push(() => { try { lift.cancel(); } catch {} });

      const shadowFade = shadow.animate(
        [
          { opacity: 0.6 },
          { opacity: 0.12 },
        ],
        { duration: 360, easing: 'ease-out', fill: 'forwards' }
      );
      cancellers.push(() => { try { shadowFade.cancel(); } catch {} });

      const card = document.createElement('div');
      card.className = 'fortune-card dice-card';
      const pool = FORTUNE_DICE_SAYINGS[n] || [];
      const saying = pool[Math.floor(Math.random() * pool.length)] || '';
      card.innerHTML =
        '<div class="fortune-result"></div>' +
        '<div class="fortune-hint">再 点 散 场</div>';
      overlay.appendChild(card);

      const resultEl = card.querySelector('.fortune-result');
      const hintEl = card.querySelector('.fortune-hint');

      // .dice-card has translateX(-50%) baked in via CSS; keep it in every
      // keyframe so the animation doesn't drift it off-center.
      const cardIn = card.animate(
        [
          { opacity: 0, transform: 'translate(-50%, 14px)' },
          { opacity: 1, transform: 'translate(-50%, 0)' },
        ],
        { duration: 320, easing: 'cubic-bezier(0.16, 1.0, 0.36, 1)', fill: 'forwards' }
      );
      cancellers.push(() => { try { cardIn.cancel(); } catch {} });

      revealFortune(resultEl, hintEl, saying, 'dice');
      phase = 'shown';
    }, STOP_MS + 120);
    cancellers.push(() => clearTimeout(reveal));
  }

  function onClick() {
    if (phase === 'spinning') tryStop();
    else if (phase === 'shown') close();
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
      e.preventDefault();
      if (phase === 'spinning') tryStop();
      else if (phase === 'shown') close();
    }
  }

  overlay.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey);
  cancellers.push(() => document.removeEventListener('keydown', onKey));
}

// === Lots: 7 sticks spread into a fan, user clicks one to pick. ===
function stageLotsDraw() {
  const { overlay, close, cancellers } = buildFortuneOverlay('lots');

  const prompt = document.createElement('div');
  prompt.className = 'lots-prompt';
  prompt.textContent = '点  击  摇  签';
  overlay.appendChild(prompt);

  // Bamboo tube with sticks visible at the top, a wood rim, and a soft shadow.
  const tubeWrap = document.createElement('div');
  tubeWrap.className = 'lots-tube-wrap';

  const tube = document.createElement('div');
  tube.className = 'lots-tube';

  const stickRow = document.createElement('div');
  stickRow.className = 'lots-tube-sticks';
  // Visible stick tops poking out of the tube — varied heights look hand-loaded.
  [38, 52, 44, 60, 48, 40, 56].forEach((h) => {
    const s = document.createElement('span');
    s.style.height = h + '%';
    stickRow.appendChild(s);
  });
  tube.appendChild(stickRow);

  const grain = document.createElement('div');
  grain.className = 'lots-tube-grain';
  tube.appendChild(grain);

  const rim = document.createElement('div');
  rim.className = 'lots-tube-rim';
  tube.appendChild(rim);

  const tubeShadow = document.createElement('div');
  tubeShadow.className = 'lots-tube-shadow';

  tubeWrap.appendChild(tube);
  tubeWrap.appendChild(tubeShadow);
  overlay.appendChild(tubeWrap);

  let phase = 'waiting'; // → 'shaking' → 'shown'

  function shakeAndDraw() {
    prompt.classList.add('hide');
    tube.classList.add('shaking');

    const shakeDur = 720 + Math.floor(Math.random() * 200);
    const stop = setTimeout(() => {
      tube.classList.remove('shaking');
      drawStick();
    }, shakeDur);
    cancellers.push(() => clearTimeout(stop));
  }

  function drawStick() {
    const lot = weightedPick(FORTUNE_LOTS);
    const sayings = lot.sayings || [''];
    const saying = sayings[Math.floor(Math.random() * sayings.length)];
    const interps = lot.interps || [''];
    const interp = interps[Math.floor(Math.random() * interps.length)];
    const number = 1 + Math.floor(Math.random() * 100);
    const numCh = toChineseNum(number);

    // The chosen stick rises out of the tube into a clear plaque above it.
    // Tier on top, stick number below — bold horizontal text so they read at
    // a glance. Final rise offset is small so the plaque stays on-screen.
    const stick = document.createElement('div');
    stick.className = 'lots-rising-stick';
    stick.innerHTML =
      `<div class="lots-rising-tier">${Array.from(lot.tier).join(' ')}</div>` +
      '<div class="lots-rising-divider"></div>' +
      `<div class="lots-rising-num">第 ${numCh} 号</div>`;
    tubeWrap.appendChild(stick);

    const riseAnim = stick.animate(
      [
        { transform: 'translate(-50%, 100%) scale(0.78)', opacity: 0 },
        { transform: 'translate(-50%, 30%)  scale(0.96)', opacity: 1, offset: 0.45 },
        { transform: 'translate(-50%, -18%) scale(1.04)', opacity: 1, offset: 0.78 },
        { transform: 'translate(-50%, -10%) scale(1)',    opacity: 1 },
      ],
      { duration: 780, easing: 'cubic-bezier(0.18, 0.78, 0.22, 1.05)', fill: 'forwards' }
    );
    cancellers.push(() => { try { riseAnim.cancel(); } catch {} });

    // After the stick reaches its resting spot, slide the tube + plaque left
    // and surface the saying on an aged paper bookmark on the right side,
    // plus interp + hint below.
    const reveal = setTimeout(() => {
      overlay.classList.add('revealed');

      const scroll = document.createElement('div');
      scroll.className = 'lots-scroll';
      scroll.innerHTML =
        '<div class="lots-scroll-rod lots-scroll-rod-top"></div>' +
        '<div class="lots-scroll-paper">' +
          '<div class="fortune-result lots-scroll-text"></div>' +
        '</div>' +
        '<div class="lots-scroll-rod lots-scroll-rod-bottom"></div>';
      overlay.appendChild(scroll);

      const interpEl = document.createElement('div');
      interpEl.className = 'fortune-result lots-interp-text';
      const hint = document.createElement('div');
      hint.className = 'fortune-hint';
      hint.textContent = '轻 点 散 场';
      overlay.appendChild(interpEl);
      overlay.appendChild(hint);

      // Scroll slides up + fades in (resting position is right of viewport center).
      const scrollIn = scroll.animate(
        [
          { opacity: 0, transform: 'translate(calc(-50% + 110px), calc(-50% + 22px)) scale(0.94)' },
          { opacity: 1, transform: 'translate(calc(-50% + 110px), -50%) scale(1)' },
        ],
        { duration: 420, easing: 'cubic-bezier(0.18, 0.78, 0.22, 1.05)', fill: 'forwards' }
      );
      cancellers.push(() => { try { scrollIn.cancel(); } catch {} });

      // Brush-write the saying down the paper, then the interp horizontally
      // below, then surface the dismiss hint.
      const sayingEl = scroll.querySelector('.lots-scroll-text');
      const sayStart = setTimeout(() => {
        sayingEl.classList.add('show');
        const sayOut = inkWrite(sayingEl, saying, { delayPer: 105, charDur: 280 });
        cancellers.push(sayOut.cancel);

        const interpStart = setTimeout(() => {
          interpEl.classList.add('show');
          const intOut = inkWrite(interpEl, interp, { delayPer: 55, charDur: 220 });
          cancellers.push(intOut.cancel);
          const hintShow = setTimeout(() => hint.classList.add('show'), intOut.totalMs + 100);
          cancellers.push(() => clearTimeout(hintShow));
        }, sayOut.totalMs + 240);
        cancellers.push(() => clearTimeout(interpStart));
      }, 280);
      cancellers.push(() => clearTimeout(sayStart));

      phase = 'shown';
    }, 760);
    cancellers.push(() => clearTimeout(reveal));
  }

  function onClick() {
    if (phase === 'waiting') {
      phase = 'shaking';
      shakeAndDraw();
    } else if (phase === 'shown') {
      close();
    }
    // 'shaking' phase ignores clicks
  }

  overlay.addEventListener('click', onClick);
}

// === Saying: paper messenger flies in, unfolds into a letter, ink writes. ===
function stageSpringSaying() {
  const { overlay, close, cancellers } = buildFortuneOverlay('saying');

  const crane = document.createElement('div');
  crane.className = 'paper-crane';
  crane.innerHTML =
    '<div class="paper-crane-wing paper-crane-wing-l"></div>' +
    '<div class="paper-crane-wing paper-crane-wing-r"></div>' +
    '<div class="paper-crane-body"></div>';
  overlay.appendChild(crane);

  const PETAL_GLYPHS = ['❀', '✿', '❁', '✾'];
  const PETAL_COLORS = ['#f7a6c1', '#fbc4d3', '#ef9bb6', '#f9c8d6'];
  for (let i = 0; i < 4; i++) {
    const p = document.createElement('span');
    p.className = 'breeze-petal breeze-petal-overlay';
    p.textContent = PETAL_GLYPHS[i % PETAL_GLYPHS.length];
    p.style.color = PETAL_COLORS[i % PETAL_COLORS.length];
    p.style.fontSize = `${14 + Math.random() * 10}px`;
    overlay.appendChild(p);

    const dx = -8 + Math.random() * 16;
    const dy = -4 + Math.random() * 8;
    const dur = 2000 + Math.random() * 700;
    const delay = 220 + i * 140;
    const spin = (Math.random() < 0.5 ? -1 : 1) * (360 + Math.random() * 240);

    const a = p.animate(
      [
        { transform: `translate(40vw, -12vh) rotate(0deg)`, opacity: 0 },
        { transform: `translate(${dx}vw, ${dy}vh) rotate(${spin * 0.5}deg)`, opacity: 0.95, offset: 0.55 },
        { transform: `translate(${dx - 28}vw, ${dy + 14}vh) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: dur, delay, easing: 'cubic-bezier(0.4, 0.06, 0.55, 0.95)', fill: 'forwards' }
    );
    cancellers.push(() => { try { a.cancel(); } catch {} });
  }

  // Crane flies in S-curve from off-screen top-right to overlay center.
  const flyAnim = crane.animate(
    [
      { transform: 'translate(-50%, -50%) translate(48vw, -32vh) rotate(38deg) scale(0.65)', opacity: 0 },
      { transform: 'translate(-50%, -50%) translate(22vw, -6vh)  rotate(18deg) scale(0.88)', opacity: 1, offset: 0.4 },
      { transform: 'translate(-50%, -50%) translate(-8vw, 8vh)   rotate(-10deg) scale(0.96)', opacity: 1, offset: 0.74 },
      { transform: 'translate(-50%, -50%) translate(0, 0)         rotate(0deg)  scale(1)',   opacity: 1 },
    ],
    { duration: 1400, easing: 'cubic-bezier(0.36, 0.02, 0.4, 1)', fill: 'forwards' }
  );
  cancellers.push(() => { try { flyAnim.cancel(); } catch {} });

  const saying = FORTUNE_SAYINGS[Math.floor(Math.random() * FORTUNE_SAYINGS.length)];

  const unfold = setTimeout(() => {
    const craneOut = crane.animate(
      [
        { opacity: 1, transform: 'translate(-50%, -50%) scale(1) rotate(0deg)' },
        { opacity: 0, transform: 'translate(-50%, -50%) scale(0.35) rotate(0deg)' },
      ],
      { duration: 280, easing: 'ease-in', fill: 'forwards' }
    );
    cancellers.push(() => { try { craneOut.cancel(); } catch {} });

    const letter = document.createElement('div');
    letter.className = 'paper-letter';
    letter.innerHTML =
      '<div class="paper-letter-rod paper-letter-rod-l"></div>' +
      '<div class="paper-letter-rod paper-letter-rod-r"></div>' +
      '<div class="paper-letter-body">' +
        '<div class="fortune-result paper-letter-line"></div>' +
      '</div>' +
      '<div class="fortune-hint">轻 点 收 起</div>';
    overlay.appendChild(letter);

    const openAnim = letter.animate(
      [
        { clipPath: 'inset(0 50% 0 50%)', opacity: 0 },
        { clipPath: 'inset(0 0 0 0)',     opacity: 1 },
      ],
      { duration: 480, easing: 'cubic-bezier(0.16, 1, 0.36, 1)', fill: 'forwards' }
    );
    cancellers.push(() => { try { openAnim.cancel(); } catch {} });

    const lineEl = letter.querySelector('.paper-letter-line');
    const hintEl = letter.querySelector('.fortune-hint');

    const writeStart = setTimeout(() => {
      revealFortune(lineEl, hintEl, saying, 'saying');
    }, 460);
    cancellers.push(() => clearTimeout(writeStart));
  }, 1400);
  cancellers.push(() => clearTimeout(unfold));

  overlay.addEventListener('click', close);
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
  onScanDirResult: (reqId, payload) => Sidebar.onScanDirResult(reqId, payload),
  toast: (message, type) => showToast(message, type),
  selectAllContent,
  toggleSidebar: () => Sidebar.toggleCollapsed(),
  setLoading,
  setRecents: (list) => Sidebar.setRecents(list),
};
