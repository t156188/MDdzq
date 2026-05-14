import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    static let markdown = UTType(importedAs: "net.daringfireball.markdown")
}

struct MarkdownDocument: FileDocument {
    static var readableContentTypes: [UTType] {
        [.markdown, .plainText, .folder]
    }

    var text: String
    /// When opened from a folder, the relative path (within the folder) of
    /// the .md we auto-picked, so the host can mark it as the current file
    /// in the sidebar. Nil for plain file opens or when the folder had no md.
    var pickedRelativePath: String?

    init(text: String = "", pickedRelativePath: String? = nil) {
        self.text = text
        self.pickedRelativePath = pickedRelativePath
    }

    init(configuration: ReadConfiguration) throws {
        let wrapper = configuration.file
        if wrapper.isDirectory {
            if let (subPath, data) = Self.pickDefaultMarkdown(in: wrapper) {
                self.text = Self.decode(data)
                self.pickedRelativePath = subPath
            } else {
                // Folder had no .md inside — open with an empty document so
                // the sidebar still shows the workspace tree.
                self.text = ""
                self.pickedRelativePath = nil
            }
        } else {
            guard let data = wrapper.regularFileContents else {
                throw CocoaError(.fileReadCorruptFile)
            }
            self.text = Self.decode(data)
            self.pickedRelativePath = nil
        }
    }

    // Reader-only: writing is not supported.
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        throw CocoaError(.featureUnsupported)
    }

    // MARK: - Helpers

    private static let mdExtensions: Set<String> = ["md", "markdown", "mdown", "mkd", "mkdn"]

    private static func decode(_ data: Data) -> String {
        if let s = String(data: data, encoding: .utf8) { return s }
        if let s = String(data: data, encoding: .utf16) { return s }
        return String(decoding: data, as: UTF8.self)
    }

    /// Find a sensible "default" markdown file inside a folder wrapper:
    /// README (any md extension, case-insensitive) wins; otherwise the first
    /// regular .md in alphabetical order. Only inspects the immediate
    /// children — opening a giant repo shouldn't recurse here.
    private static func pickDefaultMarkdown(in dir: FileWrapper) -> (String, Data)? {
        guard let children = dir.fileWrappers else { return nil }
        // Sort entries by name for stable picks.
        let entries = children
            .map { (name: $0.key, wrapper: $0.value) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

        // First pass: README.<md-ext>, case-insensitive.
        for (name, wrapper) in entries where wrapper.isRegularFile {
            let lower = name.lowercased()
            let url = URL(fileURLWithPath: lower)
            let stem = url.deletingPathExtension().lastPathComponent
            let ext = url.pathExtension
            if stem == "readme" && mdExtensions.contains(ext) {
                if let data = wrapper.regularFileContents {
                    return (name, data)
                }
            }
        }
        // Second pass: first plain .md.
        for (name, wrapper) in entries where wrapper.isRegularFile {
            let ext = (name as NSString).pathExtension.lowercased()
            if mdExtensions.contains(ext) {
                if let data = wrapper.regularFileContents {
                    return (name, data)
                }
            }
        }
        return nil
    }
}
