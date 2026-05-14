import SwiftUI

enum SidebarTab: String, CaseIterable, Identifiable {
    case files, outline
    var id: String { rawValue }
    var label: String {
        switch self {
        case .files: return "Files"
        case .outline: return "Outline"
        }
    }
    var icon: String {
        switch self {
        case .files: return "folder"
        case .outline: return "list.bullet.indent"
        }
    }
}

struct Sidebar: View {
    @ObservedObject var session: DocumentSession
    let onJumpTo: (OutlineItem) -> Void

    @State private var tab: SidebarTab = .files

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(SidebarTab.allCases) { t in
                    Label(t.label, systemImage: t.icon).tag(t)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 8)
            .padding(.top, 8)
            .padding(.bottom, 6)

            Divider()

            switch tab {
            case .files:
                FileTreeView(
                    root: session.rootDirectory,
                    currentURL: session.fileURL,
                    onSelect: { session.load(url: $0) }
                )
            case .outline:
                OutlineView(items: session.outline, onSelect: onJumpTo)
            }
        }
        .frame(minWidth: 200, idealWidth: 240, maxWidth: 400)
    }
}
