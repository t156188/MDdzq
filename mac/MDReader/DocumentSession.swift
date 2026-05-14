import Foundation
import Combine

struct OutlineItem: Identifiable, Equatable, Hashable {
    let id: String       // anchor id from the renderer
    let level: Int       // 1-6
    let text: String
}

@MainActor
final class DocumentSession: ObservableObject {
    @Published var fileURL: URL?
    @Published private(set) var text: String
    @Published var outline: [OutlineItem] = []

    init(text: String, fileURL: URL?) {
        self.text = text
        self.fileURL = fileURL
    }

    var rootDirectory: URL? {
        fileURL?.deletingLastPathComponent()
    }

    func load(url: URL) {
        guard let data = try? Data(contentsOf: url) else { return }
        let s = String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .utf16)
            ?? String(decoding: data, as: UTF8.self)
        self.fileURL = url
        self.text = s
        self.outline = []
    }
}
