import SwiftUI
import WebKit

struct MarkdownWebView: NSViewRepresentable {
    let text: String
    let workspaceRoot: URL?
    let imageBase: URL?
    let currentFile: URL?
    let isDark: Bool
    let themePref: String
    let pageZoom: Double
    let treeNonce: Int
    let onRequestOpen: (URL) -> Void
    let onFsOp: (FsOpRequest, @escaping (String, String) -> Void) -> Void
    let onSetThemePref: (String) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onRequestOpen: onRequestOpen,
            onFsOp: onFsOp,
            onSetThemePref: onSetThemePref
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "didRender")
        config.userContentController.add(context.coordinator, name: "openFile")
        config.userContentController.add(context.coordinator, name: "fsOp")
        config.userContentController.add(context.coordinator, name: "setThemePref")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false
        webView.pageZoom = CGFloat(pageZoom)
        if #available(macOS 13.3, *) {
            webView.isInspectable = true
        }

        context.coordinator.webView = webView
        context.coordinator.currentWorkspace = workspaceRoot
        context.coordinator.currentFile = currentFile
        context.coordinator.lastTreeNonce = treeNonce
        loadTemplate(into: webView, workspaceRoot: workspaceRoot)

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let coord = context.coordinator
        coord.onRequestOpen = onRequestOpen
        coord.onFsOp = onFsOp
        coord.onSetThemePref = onSetThemePref

        if abs(webView.pageZoom - CGFloat(pageZoom)) > 0.001 {
            webView.pageZoom = CGFloat(pageZoom)
        }

        let themeName = isDark ? "dark" : "light"

        if coord.currentWorkspace != workspaceRoot {
            coord.currentWorkspace = workspaceRoot
            coord.currentFile = currentFile
            coord.lastTreeNonce = treeNonce
            coord.isReady = false
            coord.pendingText = text
            coord.pendingTheme = themeName
            coord.pendingThemePref = themePref
            coord.pendingTreeJSON = FileTree.payloadJSON(root: workspaceRoot, current: currentFile)
            loadTemplate(into: webView, workspaceRoot: workspaceRoot)
            return
        }

        if coord.isReady {
            coord.pushTheme(themeName, pref: themePref)
            if coord.lastPushedText != text {
                coord.pushRender(text: text, imageBase: imageBase)
            }
            let fileChanged = coord.currentFile != currentFile
            let nonceChanged = coord.lastTreeNonce != treeNonce
            if fileChanged || nonceChanged {
                coord.currentFile = currentFile
                coord.lastTreeNonce = treeNonce
                if let json = FileTree.payloadJSON(root: workspaceRoot, current: currentFile) {
                    coord.pushTree(json: json)
                }
            }
        } else {
            coord.pendingText = text
            coord.pendingTheme = themeName
            coord.pendingThemePref = themePref
            coord.pendingTreeJSON =
                FileTree.payloadJSON(root: workspaceRoot, current: currentFile)
        }
    }

    private func loadTemplate(into webView: WKWebView, workspaceRoot: URL?) {
        let viewerURL = Bundle.main.url(forResource: "viewer", withExtension: "html", subdirectory: "Resources")
            ?? Bundle.main.url(forResource: "viewer", withExtension: "html")
        guard let viewerURL else {
            assertionFailure("viewer.html missing from bundle")
            return
        }
        let readAccessRoot: URL
        if let docDir = workspaceRoot {
            readAccessRoot = commonAncestor(viewerURL.deletingLastPathComponent(), docDir)
        } else {
            readAccessRoot = viewerURL.deletingLastPathComponent()
        }
        webView.loadFileURL(viewerURL, allowingReadAccessTo: readAccessRoot)
    }

    private func commonAncestor(_ a: URL, _ b: URL) -> URL {
        let ac = a.standardizedFileURL.pathComponents
        let bc = b.standardizedFileURL.pathComponents
        var i = 0
        while i < ac.count, i < bc.count, ac[i] == bc[i] { i += 1 }
        let shared = Array(ac.prefix(i))
        if shared.isEmpty { return URL(fileURLWithPath: "/") }
        let path = shared.joined(separator: "/").replacingOccurrences(of: "//", with: "/")
        return URL(fileURLWithPath: path.hasPrefix("/") ? path : "/" + path, isDirectory: true)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        var onRequestOpen: (URL) -> Void
        var onFsOp: (FsOpRequest, @escaping (String, String) -> Void) -> Void
        var onSetThemePref: (String) -> Void
        var isReady = false
        var pendingText: String?
        var pendingTheme: String?
        var pendingThemePref: String?
        var pendingTreeJSON: String?
        var lastPushedText: String?
        var lastPushedTheme: String?
        var lastPushedThemePref: String?
        var currentWorkspace: URL?
        var currentFile: URL?
        var lastTreeNonce: Int = 0

        init(
            onRequestOpen: @escaping (URL) -> Void,
            onFsOp: @escaping (FsOpRequest, @escaping (String, String) -> Void) -> Void,
            onSetThemePref: @escaping (String) -> Void
        ) {
            self.onRequestOpen = onRequestOpen
            self.onFsOp = onFsOp
            self.onSetThemePref = onSetThemePref
            super.init()
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleToggleSidebar),
                name: .mdreaderToggleSidebar,
                object: nil
            )
        }

        deinit {
            NotificationCenter.default.removeObserver(self)
        }

        @objc func handleToggleSidebar() {
            guard let webView, isReady else { return }
            webView.evaluateJavaScript(
                "window.MDViewerAPI && window.MDViewerAPI.toggleSidebar && window.MDViewerAPI.toggleSidebar();",
                completionHandler: nil
            )
        }

        func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
            // The page is reloading (Cmd+R, crash recovery, etc.). Save the
            // last known state so didFinish can re-push it into the fresh DOM.
            if pendingText == nil { pendingText = lastPushedText }
            if pendingTheme == nil { pendingTheme = lastPushedTheme }
            if pendingThemePref == nil { pendingThemePref = lastPushedThemePref }
            if pendingTreeJSON == nil, let root = currentWorkspace {
                pendingTreeJSON = FileTree.payloadJSON(root: root, current: currentFile)
            }
            isReady = false
            lastPushedText = nil
            lastPushedTheme = nil
            lastPushedThemePref = nil
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isReady = true
            if let theme = pendingTheme {
                pushTheme(theme, pref: pendingThemePref ?? "system")
                pendingTheme = nil
                pendingThemePref = nil
            }
            if let text = pendingText {
                let base = (currentFile?.deletingLastPathComponent())
                    ?? currentWorkspace
                pushRender(text: text, imageBase: base)
                pendingText = nil
            }
            if let json = pendingTreeJSON {
                pushTree(json: json)
                pendingTreeJSON = nil
            }
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            switch message.name {
            case "openFile":
                guard let body = message.body as? [String: Any],
                      let path = body["path"] as? String else { return }
                let url = URL(fileURLWithPath: path)
                let cb = onRequestOpen
                DispatchQueue.main.async { cb(url) }
            case "fsOp":
                guard let body = message.body as? [String: Any],
                      let op = body["op"] as? String,
                      let path = body["path"] as? String else { return }
                let req = FsOpRequest(
                    op: op,
                    path: path,
                    newName: body["newName"] as? String
                )
                let handler = onFsOp
                let toast: (String, String) -> Void = { [weak self] msg, kind in
                    self?.toast(message: msg, kind: kind)
                }
                DispatchQueue.main.async { handler(req, toast) }
            case "setThemePref":
                guard let pref = message.body as? String,
                      pref == "system" || pref == "light" || pref == "dark" else { return }
                let cb = onSetThemePref
                DispatchQueue.main.async { cb(pref) }
            default:
                break
            }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard navigationAction.navigationType == .linkActivated,
                  let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }
            // External links → system browser, never let WKWebView navigate.
            if !url.isFileURL {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            // Same-page anchor inside the viewer template — allow the scroll.
            if let current = webView.url, current.path == url.path {
                decisionHandler(.allow)
                return
            }
            // A file:// link to some other path: if it's a .md, route through
            // the in-window loader; otherwise cancel so we never lose the
            // viewer template (which would leave the WKWebView showing raw
            // text or, worse, a crashed-page "Reload" UI).
            if FileTree.extensions.contains(url.pathExtension.lowercased()) {
                let cb = onRequestOpen
                DispatchQueue.main.async { cb(url) }
            }
            decisionHandler(.cancel)
        }

        func pushTheme(_ theme: String, pref: String) {
            guard let webView, isReady else { return }
            if lastPushedTheme == theme && lastPushedThemePref == pref { return }
            lastPushedTheme = theme
            lastPushedThemePref = pref
            let js = "window.MDViewerAPI && window.MDViewerAPI.setTheme({name: \(encode(theme)), pref: \(encode(pref))});"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushRender(text: String, imageBase: URL?) {
            guard let webView, isReady else { return }
            lastPushedText = text
            let base = imageBase?.absoluteString ?? ""
            let js =
                "window.MDViewerAPI && window.MDViewerAPI.render(\(encode(text)), \(encode(base)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushTree(json: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.setFileTree(\(json));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func toast(message: String, kind: String) {
            guard let webView, isReady else { return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.toast && window.MDViewerAPI.toast(\(encode(message)), \(encode(kind)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        private func encode(_ s: String) -> String {
            let data = try? JSONSerialization.data(
                withJSONObject: [s], options: [.fragmentsAllowed]
            )
            if let data, let json = String(data: data, encoding: .utf8),
               json.hasPrefix("["), json.hasSuffix("]") {
                return String(json.dropFirst().dropLast())
            }
            return "\"\""
        }
    }
}
