import SwiftUI
import AppKit

struct ContentView: View {
    let document: MarkdownDocument
    let fileURL: URL?

    @StateObject private var session: DocumentSession
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage("pageZoom") private var pageZoom: Double = 1.0
    @AppStorage("themeOverride") private var themeOverride: String = "system"

    init(document: MarkdownDocument, fileURL: URL?) {
        self.document = document
        self.fileURL = fileURL
        _session = StateObject(
            wrappedValue: DocumentSession(text: document.text, fileURL: fileURL)
        )
    }

    var body: some View {
        MarkdownWebView(
            text: session.text,
            workspaceRoot: session.workspaceRoot,
            imageBase: session.imageBase,
            currentFile: session.fileURL,
            isDark: colorScheme == .dark,
            themePref: themeOverride,
            pageZoom: pageZoom,
            treeNonce: session.treeNonce,
            onRequestOpen: { url in session.load(url: url) },
            onFsOp: handleFsOp,
            onSetThemePref: { themeOverride = $0 }
        )
        .ignoresSafeArea()
        .navigationTitle(session.fileURL?.lastPathComponent ?? "MDReader")
    }

    private func handleFsOp(_ op: FsOpRequest, _ toast: @escaping (String, String) -> Void) {
        let src = URL(fileURLWithPath: op.path)
        switch op.op {
        case "reveal":
            NSWorkspace.shared.activateFileViewerSelecting([src])

        case "copyPath":
            let pb = NSPasteboard.general
            pb.clearContents()
            pb.setString(op.path, forType: .string)
            toast("Path copied", "info")

        case "rename":
            guard let newName = op.newName,
                  !newName.isEmpty,
                  !newName.contains("/") else {
                toast("Invalid name", "error"); return
            }
            let dst = src.deletingLastPathComponent().appendingPathComponent(newName)
            if FileManager.default.fileExists(atPath: dst.path) {
                toast("A file with that name already exists", "error"); return
            }
            do {
                try FileManager.default.moveItem(at: src, to: dst)
                if session.fileURL == src {
                    session.rebind(to: dst)
                } else {
                    session.bumpTree()
                }
                toast("Renamed", "info")
            } catch {
                toast("Rename failed: \(error.localizedDescription)", "error")
            }

        case "delete":
            if session.fileURL == src {
                toast("Close the file before deleting it", "error"); return
            }
            do {
                try FileManager.default.trashItem(at: src, resultingItemURL: nil)
                session.bumpTree()
                toast("Moved to Trash", "info")
            } catch {
                toast("Delete failed: \(error.localizedDescription)", "error")
            }

        default:
            break
        }
    }
}

struct FsOpRequest {
    let op: String
    let path: String
    let newName: String?
}
