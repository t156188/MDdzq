import SwiftUI
import UniformTypeIdentifiers

@main
struct MDReaderApp: App {
    @AppStorage("themeOverride") private var themeOverride: String = "system"

    var body: some Scene {
        DocumentGroup(viewing: MarkdownDocument.self) { file in
            ContentView(document: file.document, fileURL: file.fileURL)
                .frame(minWidth: 520, minHeight: 360)
                .preferredColorScheme(colorScheme(for: themeOverride))
        }
        .commands { MDReaderCommands(themeOverride: $themeOverride) }
    }

    private func colorScheme(for value: String) -> ColorScheme? {
        switch value {
        case "light": return .light
        case "dark": return .dark
        default: return nil
        }
    }
}
