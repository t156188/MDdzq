import SwiftUI

struct MDReaderCommands: Commands {
    @Binding var themeOverride: String

    var body: some Commands {
        CommandGroup(replacing: .appInfo) {
            Button("About MDGEM") {
                NSApp.orderFrontStandardAboutPanel()
            }
        }
        CommandGroup(after: .toolbar) {
            Picker("Appearance", selection: $themeOverride) {
                Text("Follow System").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
            }
            Divider()
        }
    }
}
