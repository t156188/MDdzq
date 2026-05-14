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
        // If DocumentGroup hands us a folder URL, treat it as a workspace
        // root and use the document's auto-picked file (if any) as the
        // current file. Plain file opens keep the old behavior.
        let isDir = (try? fileURL?.resourceValues(forKeys: [.isDirectoryKey]).isDirectory)
            ?? false
        let workspace: URL?
        let currentFile: URL?
        if let folder = fileURL, isDir == true {
            workspace = folder
            currentFile = document.pickedRelativePath
                .map { folder.appendingPathComponent($0) }
        } else {
            workspace = fileURL?.deletingLastPathComponent()
            currentFile = fileURL
        }
        self.fileURL = currentFile
        _session = StateObject(
            wrappedValue: DocumentSession(
                text: document.text,
                fileURL: currentFile,
                workspaceRoot: workspace
            )
        )
        // Record the initial file (from DocumentGroup open / folder pick) as a
        // recent. Subsequent sidebar clicks go through `session.load(url:)`,
        // which also records — see DocumentSession.
        if let f = currentFile {
            RecentFiles.add(f.path)
        }
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
        .navigationTitle(
            session.fileURL?.lastPathComponent
                ?? session.workspaceRoot?.lastPathComponent
                ?? "MDReader"
        )
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

        case "newFile", "newFolder":
            guard let newName = op.newName?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                  !newName.isEmpty,
                  !newName.contains("/") else {
                toast("Invalid name", "error"); return
            }
            // op.path is the parent directory; src points at it.
            let dst = src.appendingPathComponent(newName)
            if FileManager.default.fileExists(atPath: dst.path) {
                toast("Already exists", "error"); return
            }
            do {
                if op.op == "newFolder" {
                    try FileManager.default.createDirectory(
                        at: dst, withIntermediateDirectories: false
                    )
                } else {
                    try Data().write(to: dst)
                }
                session.bumpTree()
                toast("Created", "info")
            } catch {
                toast("Create failed: \(error.localizedDescription)", "error")
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
