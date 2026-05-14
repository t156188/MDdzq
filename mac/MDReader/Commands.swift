import SwiftUI

extension Notification.Name {
    static let mdreaderToggleSidebar = Notification.Name("mdreader.toggleSidebar")
}

struct MDReaderCommands: Commands {
    @Binding var themeOverride: String
    @Binding var pageZoom: Double

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            Button("About MDGEM") {
                NSApp.orderFrontStandardAboutPanel()
            }
        }
        CommandGroup(after: .toolbar) {
            Button("Toggle Sidebar") {
                NotificationCenter.default.post(name: .mdreaderToggleSidebar, object: nil)
            }
            .keyboardShortcut("b", modifiers: .command)
            Divider()
            Picker("Appearance", selection: $themeOverride) {
                Text("Follow System").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }
            Divider()
            Button("Zoom In") { pageZoom = min(3.0, pageZoom + 0.1) }
                .keyboardShortcut("=", modifiers: .command)
            Button("Zoom Out") { pageZoom = max(0.4, pageZoom - 0.1) }
                .keyboardShortcut("-", modifiers: .command)
            Button("Actual Size") { pageZoom = 1.0 }
                .keyboardShortcut("0", modifiers: .command)
            Divider()
        }
    }
}
