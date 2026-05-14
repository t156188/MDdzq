// Injected before viewer.html scripts run.
// Bridges Tauri Rust ↔ the shared `window.MDViewerAPI` exported by viewer.bundle.js.
(function () {
  function tauri() { return window.__TAURI__; }
  function convertFileSrc(path) {
    var core = tauri() && (tauri().core || tauri());
    if (core && typeof core.convertFileSrc === 'function') {
      return core.convertFileSrc(path);
    }
    return path;
  }

  function decodeFileUrl(url) {
    // file:///C:/path/foo.png → /C:/path/foo.png → C:/path/foo.png
    var stripped = url.replace(/^file:\/\//i, '');
    try { stripped = decodeURI(stripped); } catch (_) {}
    if (/^\/[A-Za-z]:\//.test(stripped)) stripped = stripped.slice(1);
    return stripped;
  }

  function fixImages() {
    var root = document.getElementById('root');
    if (!root) return;
    var imgs = root.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute('src') || '';
      if (/^file:\/\//i.test(src)) {
        try { img.src = convertFileSrc(decodeFileUrl(src)); } catch (_) {}
      }
    }
  }

  function installLinkInterceptor() {
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) {
        e.preventDefault();
        var ev = tauri() && tauri().event;
        if (ev && typeof ev.emit === 'function') {
          ev.emit('mdreader:open-external', href);
        }
      }
    }, true);
  }

  function wrapRender() {
    // Wait until viewer.bundle.js sets window.MDViewerAPI, then wrap render() so
    // we can post-process images on each render.
    var orig = null;
    function patch() {
      if (window.MDViewerAPI && window.MDViewerAPI.render && !orig) {
        orig = window.MDViewerAPI.render;
        window.MDViewerAPI.render = function (text, base) {
          var p = orig(text, base);
          var done = function () { fixImages(); };
          if (p && typeof p.then === 'function') p.then(done, done);
          else done();
          return p;
        };
      }
    }
    patch();
    if (!orig) {
      var tries = 0;
      var iv = setInterval(function () {
        patch();
        if (orig || ++tries > 200) clearInterval(iv);
      }, 25);
    }
  }

  function attachTauriListeners(cb) {
    var t = tauri();
    if (!t || !t.event || typeof t.event.listen !== 'function') return false;
    t.event.listen('mdreader:render', function (e) {
      var p = (e && e.payload) || {};
      if (window.MDViewerAPI && typeof window.MDViewerAPI.render === 'function') {
        window.MDViewerAPI.render(p.text || '', p.base_dir || '');
      }
    });
    t.event.listen('mdreader:theme', function (e) {
      var p = (e && e.payload) || {};
      if (window.MDViewerAPI && typeof window.MDViewerAPI.setTheme === 'function') {
        window.MDViewerAPI.setTheme(p.name || 'light');
      }
    });
    t.event.listen('mdreader:file-tree', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.setFileTree === 'function') {
        window.MDViewerAPI.setFileTree(p);
      }
    });
    t.event.listen('mdreader:scan-dir-result', function (e) {
      var p = (e && e.payload) || null;
      if (p && window.MDViewerAPI && typeof window.MDViewerAPI.onScanDirResult === 'function') {
        window.MDViewerAPI.onScanDirResult(p.reqId, p);
      }
    });
    t.event.listen('mdreader:recents', function (e) {
      var p = (e && e.payload) || [];
      if (window.MDViewerAPI && typeof window.MDViewerAPI.setRecents === 'function') {
        window.MDViewerAPI.setRecents(Array.isArray(p) ? p : []);
      }
    });
    if (cb) cb();
    return true;
  }

  function announceReady() {
    var t = tauri();
    if (t && t.event && typeof t.event.emit === 'function') {
      t.event.emit('mdreader:ready', {});
    }
  }

  function boot() {
    installLinkInterceptor();
    wrapRender();
    var tries = 0;
    (function tryListen() {
      if (attachTauriListeners(announceReady)) return;
      if (++tries > 200) return; // give up after ~5s
      setTimeout(tryListen, 25);
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
