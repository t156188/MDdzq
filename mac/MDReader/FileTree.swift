import Foundation

/// Walks a directory and emits a JSON payload describing the .md files inside,
/// shaped for the shared front-end sidebar (Resources/viewer.entry.js).
enum FileTree {
    static let extensions: Set<String> = ["md", "markdown", "mdown", "mkd", "mkdn"]

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

    private static func scan(url: URL, isRoot: Bool) -> [String: Any]? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else {
            return nil
        }
        if isDir.boolValue {
            let contents = (try? FileManager.default.contentsOfDirectory(
                at: url,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )) ?? []
            // Folders first (alpha), then files (alpha). Matches typical
            // file-tree UIs (Finder column, VS Code Explorer, etc.).
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
