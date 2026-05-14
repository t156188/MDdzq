import Foundation

/// Walks a directory and emits a JSON payload describing the .md files inside,
/// shaped for the shared front-end sidebar (Resources/viewer.entry.js).
enum FileTree {
    static let extensions: Set<String> = ["md", "markdown", "mdown", "mkd", "mkdn"]

    /// Directory names we never recurse into eagerly. They still appear in
    /// the tree, but the front-end fetches their children on demand. Keeps
    /// projects with `node_modules`, build output, etc. from freezing the UI
    /// at workspace open time.
    static let lazyDirNames: Set<String> = [
        "node_modules", "dist", "build", "out", "target", "vendor",
        "release", "coverage", "Pods", "DerivedData", "__pycache__"
    ]

    /// JSON string suitable for `window.MDViewerAPI.setFileTree(...)`.
    static func payloadJSON(root: URL?, current: URL?) -> String? {
        guard let root, let node = scan(url: root, isRoot: true) else { return nil }
        let payload: [String: Any] = [
            "root": node,
            "current": current?.path ?? NSNull()
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }

    /// One-level scan of a single directory, used to satisfy front-end lazy
    /// expansion. Returns `{ "path": ..., "children": [...] }` JSON.
    static func scanChildrenJSON(path: String) -> String? {
        let url = URL(fileURLWithPath: path)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir),
              isDir.boolValue else { return nil }
        let children = scanChildren(of: url)
        let payload: [String: Any] = [
            "path": url.path,
            "children": children
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
              let json = String(data: data, encoding: .utf8) else { return nil }
        return json
    }

    private static func scanChildren(of url: URL) -> [[String: Any]] {
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let sorted = contents.sorted { a, b in
            let aDir = (try? a.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            let bDir = (try? b.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if aDir != bDir { return aDir && !bDir }
            return a.lastPathComponent.localizedStandardCompare(b.lastPathComponent)
                == .orderedAscending
        }
        var children: [[String: Any]] = []
        for c in sorted {
            if let n = scan(url: c, isRoot: false) { children.append(n) }
        }
        return children
    }

    private static func scan(url: URL, isRoot: Bool) -> [String: Any]? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else {
            return nil
        }
        if isDir.boolValue {
            // Heavy directory: emit a stub the front-end can expand on demand.
            // The root is always scanned eagerly, even if its own name matches
            // — otherwise opening a file inside `node_modules` would show
            // nothing.
            if !isRoot && lazyDirNames.contains(url.lastPathComponent) {
                return [
                    "type": "dir",
                    "name": url.lastPathComponent,
                    "path": url.path,
                    "lazy": true
                ]
            }
            let children = scanChildren(of: url)
            if !isRoot && children.isEmpty { return nil }
            return [
                "type": "dir",
                "name": url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent,
                "path": url.path,
                "children": children
            ]
        } else {
            guard extensions.contains(url.pathExtension.lowercased()) else { return nil }
            return [
                "type": "file",
                "name": url.lastPathComponent,
                "path": url.path
            ]
        }
    }
}
