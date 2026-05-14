import SwiftUI
import UniformTypeIdentifiers

@main
struct MDReaderApp: App {
    @AppStorage("themeOverride") private var themeOverride: String = "dark"
    @AppStorage("pageZoom") private var pageZoom: Double = 1.0

    var body: some Scene {
        DocumentGroup(viewing: MarkdownDocument.self) { file in
            ContentView(document: file.document, fileURL: file.fileURL)
                .frame(minWidth: 520, idealWidth: 900, minHeight: 360, idealHeight: 720)
                .preferredColorScheme(colorScheme(for: themeOverride))
        }
        .defaultSize(width: 900, height: 720)
        .commands {
            MDReaderCommands(themeOverride: $themeOverride, pageZoom: $pageZoom)
        }
    }

    private func colorScheme(for value: String) -> ColorScheme? {
        switch value {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}
