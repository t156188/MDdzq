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
  window.scrollTo({ top: 0, behavior: 'instant' });
  // Notify native of the outline (heading list) for the sidebar.
  try {
    window.webkit?.messageHandlers?.outline?.postMessage(outline);
  } catch {}
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

function setTheme(name) {
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

// Public API exposed to Swift via evaluateJavaScript.
window.MDViewerAPI = { render, setTheme, scrollToAnchor };
