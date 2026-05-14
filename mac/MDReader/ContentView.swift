import SwiftUI

struct ContentView: View {
    let document: MarkdownDocument
    let fileURL: URL?

    @StateObject private var session: DocumentSession
    @State private var pendingScrollAnchor: String?
    @Environment(\.colorScheme) private var colorScheme

    init(document: MarkdownDocument, fileURL: URL?) {
        self.document = document
        self.fileURL = fileURL
        _session = StateObject(
            wrappedValue: DocumentSession(text: document.text, fileURL: fileURL)
        )
    }

    var body: some View {
        NavigationSplitView {
            Sidebar(session: session) { item in
                pendingScrollAnchor = item.id
            }
        } detail: {
            MarkdownWebView(
                text: session.text,
                baseDirectory: session.rootDirectory,
                isDark: colorScheme == .dark,
                pendingScrollAnchor: $pendingScrollAnchor,
                onOutline: { items in
                    session.outline = items
                }
            )
            .ignoresSafeArea()
            .navigationTitle(session.fileURL?.lastPathComponent ?? "MDReader")
        }
        .navigationSplitViewStyle(.balanced)
    }
}
