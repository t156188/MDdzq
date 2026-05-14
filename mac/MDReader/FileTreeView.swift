import SwiftUI

struct FileNode: Identifiable, Hashable {
    let id: URL
    let url: URL
    let isDirectory: Bool
    var children: [FileNode]?

    var name: String { url.lastPathComponent }
}

enum FileTreeLoader {
    static let markdownExtensions: Set<String> = ["md", "markdown", "mdown", "mkd", "mkdn"]

    static func load(root: URL) -> FileNode? {
        guard FileManager.default.fileExists(atPath: root.path) else { return nil }
        return scan(url: root, isRoot: true)
    }

    private static func scan(url: URL, isRoot: Bool) -> FileNode? {
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
            var kids: [FileNode] = []
            for child in contents.sorted(by: nameAsc) {
                if let n = scan(url: child, isRoot: false) { kids.append(n) }
            }
            // Prune empty subdirectories so the tree stays tidy.
            if !isRoot && kids.isEmpty { return nil }
            return FileNode(id: url, url: url, isDirectory: true, children: kids)
        } else {
            let ext = url.pathExtension.lowercased()
            guard markdownExtensions.contains(ext) else { return nil }
            return FileNode(id: url, url: url, isDirectory: false, children: nil)
        }
    }

    private static func nameAsc(_ a: URL, _ b: URL) -> Bool {
        a.lastPathComponent.localizedStandardCompare(b.lastPathComponent) == .orderedAscending
    }
}

struct FileTreeView: View {
    let root: URL?
    let currentURL: URL?
    let onSelect: (URL) -> Void

    @State private var tree: FileNode?
    @State private var expanded: Set<URL> = []

    var body: some View {
        Group {
            if let tree {
                List {
                    FileNodeRow(
                        node: tree,
                        currentURL: currentURL,
                        expanded: $expanded,
                        onSelect: onSelect
                    )
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "folder")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                    Text("No folder open")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear { reload() }
        .onChange(of: root) { _ in reload() }
    }

    private func reload() {
        guard let root else { tree = nil; return }
        tree = FileTreeLoader.load(root: root)
        var openSet: Set<URL> = []
        if let tree { openSet.insert(tree.url) }
        if let cur = currentURL, let root = root as URL? {
            var p = cur.deletingLastPathComponent()
            while p.path.count >= root.path.count {
                openSet.insert(p)
                if p.path == root.path { break }
                p = p.deletingLastPathComponent()
            }
        }
        expanded = openSet
    }
}

private struct FileNodeRow: View {
    let node: FileNode
    let currentURL: URL?
    @Binding var expanded: Set<URL>
    let onSelect: (URL) -> Void

    var body: some View {
        if node.isDirectory {
            DisclosureGroup(
                isExpanded: Binding(
                    get: { expanded.contains(node.url) },
                    set: { yes in
                        if yes { expanded.insert(node.url) } else { expanded.remove(node.url) }
                    }
                )
            ) {
                if let kids = node.children {
                    ForEach(kids) { child in
                        FileNodeRow(
                            node: child,
                            currentURL: currentURL,
                            expanded: $expanded,
                            onSelect: onSelect
                        )
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "folder")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                    Text(node.name)
                        .font(.system(size: 12))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        } else {
            let isSelected = node.url == currentURL
            HStack(spacing: 5) {
                Image(systemName: "doc.text")
                    .font(.system(size: 11))
                    .foregroundStyle(isSelected ? Color.accentColor : .secondary)
                    .frame(width: 14)
                Text(node.name)
                    .font(.system(size: 12, weight: isSelected ? .medium : .regular))
                    .foregroundStyle(isSelected ? Color.accentColor : Color.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 2)
            .padding(.horizontal, 4)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(isSelected ? Color.primary.opacity(0.06) : Color.clear)
            )
            .contentShape(Rectangle())
            .onTapGesture { onSelect(node.url) }
        }
    }
}
