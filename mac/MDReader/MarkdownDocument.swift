import SwiftUI
import UniformTypeIdentifiers

extension UTType {
    static let markdown = UTType(importedAs: "net.daringfireball.markdown")
}

struct MarkdownDocument: FileDocument {
    static var readableContentTypes: [UTType] {
        [.markdown, .plainText]
    }

    var text: String

    init(text: String = "") {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        // Try UTF-8 first; fall back to the system's default encoding.
        if let s = String(data: data, encoding: .utf8) {
            self.text = s
        } else if let s = String(data: data, encoding: .utf16) {
            self.text = s
        } else {
            self.text = String(decoding: data, as: UTF8.self)
        }
    }

    // Reader-only: writing is not supported.
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        throw CocoaError(.featureUnsupported)
    }
}
