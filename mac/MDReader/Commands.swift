import SwiftUI
import AppKit

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
        // The default File → Open… (provided by DocumentGroup) uses an
        // NSOpenPanel hard-coded to canChooseDirectories=false. Adding
        // public.folder to readableContentTypes alone doesn't lift that
        // restriction, so we ship a dedicated "Open Folder…" entry.
        CommandGroup(after: .newItem) {
            Button("Open Folder…") {
                openFolder()
            }
            .keyboardShortcut("o", modifiers: [.command, .shift])
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

@MainActor
private func openFolder() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = false
    panel.canChooseDirectories = true
    panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.prompt = "Open"
    panel.message = "Choose a folder to open as a workspace"
    panel.begin { response in
        guard response == .OK, let url = panel.url else { return }
        NSDocumentController.shared.openDocument(
            withContentsOf: url,
            display: true
        ) { _, _, _ in }
    }
}
