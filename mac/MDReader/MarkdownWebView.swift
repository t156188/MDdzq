import SwiftUI
import WebKit

struct MarkdownWebView: NSViewRepresentable {
    let text: String
    let baseDirectory: URL?
    let isDark: Bool
    @Binding var pendingScrollAnchor: String?
    let onOutline: ([OutlineItem]) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onOutline: onOutline) }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.add(context.coordinator, name: "didRender")
        config.userContentController.add(context.coordinator, name: "outline")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false

        context.coordinator.webView = webView
        context.coordinator.currentBaseDir = baseDirectory
        loadTemplate(into: webView, baseDirectory: baseDirectory)

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let coord = context.coordinator
        coord.onOutline = onOutline

        if coord.currentBaseDir != baseDirectory {
            coord.currentBaseDir = baseDirectory
            coord.isReady = false
            coord.pendingText = text
            coord.pendingTheme = isDark ? "dark" : "light"
            loadTemplate(into: webView, baseDirectory: baseDirectory)
            return
        }

        if coord.isReady {
            coord.pushTheme(isDark ? "dark" : "light")
            if coord.lastPushedText != text {
                coord.pushRender(text: text, baseDirectory: baseDirectory)
            }
            if let anchor = pendingScrollAnchor {
                coord.scrollTo(anchor: anchor)
                DispatchQueue.main.async { self.pendingScrollAnchor = nil }
            }
        } else {
            coord.pendingText = text
            coord.pendingTheme = isDark ? "dark" : "light"
            if let anchor = pendingScrollAnchor {
                coord.pendingAnchor = anchor
                DispatchQueue.main.async { self.pendingScrollAnchor = nil }
            }
        }
    }

    private func loadTemplate(into webView: WKWebView, baseDirectory: URL?) {
        let viewerURL = Bundle.main.url(forResource: "viewer", withExtension: "html", subdirectory: "Resources")
            ?? Bundle.main.url(forResource: "viewer", withExtension: "html")
        guard let viewerURL else {
            assertionFailure("viewer.html missing from bundle")
            return
        }
        let readAccessRoot: URL
        if let docDir = baseDirectory {
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
        var onOutline: ([OutlineItem]) -> Void
        var isReady = false
        var pendingText: String?
        var pendingTheme: String?
        var pendingAnchor: String?
        var lastPushedText: String?
        var lastPushedTheme: String?
        var currentBaseDir: URL?

        init(onOutline: @escaping ([OutlineItem]) -> Void) {
            self.onOutline = onOutline
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isReady = true
            if let theme = pendingTheme { pushTheme(theme); pendingTheme = nil }
            if let text = pendingText {
                pushRender(text: text, baseDirectory: currentBaseDir)
                pendingText = nil
            }
            if let anchor = pendingAnchor {
                scrollTo(anchor: anchor)
                pendingAnchor = nil
            }
        }

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "outline",
                  let items = message.body as? [[String: Any]] else { return }
            let parsed: [OutlineItem] = items.compactMap { dict in
                guard let id = dict["id"] as? String,
                      let level = dict["level"] as? Int,
                      let text = dict["text"] as? String else { return nil }
                return OutlineItem(id: id, level: level, text: text)
            }
            let callback = onOutline
            DispatchQueue.main.async { callback(parsed) }
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            if navigationAction.navigationType == .linkActivated,
               let url = navigationAction.request.url,
               !url.isFileURL {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        func pushTheme(_ theme: String) {
            guard let webView, isReady else { return }
            if lastPushedTheme == theme { return }
            lastPushedTheme = theme
            let js = "window.MDViewerAPI && window.MDViewerAPI.setTheme(\(encode(theme)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func pushRender(text: String, baseDirectory: URL?) {
            guard let webView, isReady else { return }
            lastPushedText = text
            let base = baseDirectory?.absoluteString ?? ""
            let js =
                "window.MDViewerAPI && window.MDViewerAPI.render(\(encode(text)), \(encode(base)));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func scrollTo(anchor: String) {
            guard let webView, isReady else { pendingAnchor = anchor; return }
            let js = "window.MDViewerAPI && window.MDViewerAPI.scrollToAnchor(\(encode(anchor)));"
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
