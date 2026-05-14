import Foundation
import Combine

@MainActor
final class DocumentSession: ObservableObject {
    @Published var fileURL: URL?
    @Published private(set) var text: String
    /// Pinned at the first opened file's parent directory. Subsequent loads
    /// through the in-window file tree do NOT change this — the side bar
    /// should keep showing the same workspace.
    @Published private(set) var workspaceRoot: URL?
    /// Bumped after rename / delete so the WebView re-pushes the file tree.
    @Published private(set) var treeNonce: Int = 0

    init(text: String, fileURL: URL?) {
        self.text = text
        self.fileURL = fileURL
        self.workspaceRoot = fileURL?.deletingLastPathComponent()
    }

    /// Image base for relative `![](pic.png)` links — tracks the current file.
    var imageBase: URL? {
        fileURL?.deletingLastPathComponent()
    }

    /// Load another document inside the same workspace (sidebar click).
    func load(url: URL) {
        guard let data = try? Data(contentsOf: url) else { return }
        let s = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .utf16)
            ?? String(decoding: data, as: UTF8.self)
        self.fileURL = url
        self.text = s
    }

    /// Re-bind to a new URL after a rename of the currently-open file.
    func rebind(to url: URL) {
        self.fileURL = url
        bumpTree()
    }

    func bumpTree() {
        treeNonce &+= 1
    }
}
