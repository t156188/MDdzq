import SwiftUI

struct OutlineView: View {
    let items: [OutlineItem]
    let onSelect: (OutlineItem) -> Void

    @State private var selected: OutlineItem.ID?

    var body: some View {
        if items.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "list.bullet.indent")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text("No headings")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let minLevel = items.map(\.level).min() ?? 1
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 1) {
                    ForEach(items) { item in
                        OutlineRow(
                            item: item,
                            indent: CGFloat(max(0, item.level - minLevel)) * 12,
                            isSelected: item.id == selected
                        )
                        .onTapGesture {
                            selected = item.id
                            onSelect(item)
                        }
                    }
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 4)
            }
            .onChange(of: items) { _ in selected = nil }
        }
    }
}

private struct OutlineRow: View {
    let item: OutlineItem
    let indent: CGFloat
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 0) {
            // A thin accent bar on the left when selected — clearer than a fill.
            Rectangle()
                .fill(isSelected ? Color.accentColor : Color.clear)
                .frame(width: 2)
                .padding(.vertical, 1)

            Text(item.text)
                .font(fontFor(level: item.level))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(isSelected ? Color.accentColor : foregroundFor(level: item.level))
                .padding(.leading, 6 + indent)
                .padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(isSelected ? Color.primary.opacity(0.05) : Color.clear)
        )
        .contentShape(Rectangle())
    }

    private func fontFor(level: Int) -> Font {
        switch level {
        case 1: return .system(size: 12.5, weight: .semibold)
        case 2: return .system(size: 12, weight: .medium)
        default: return .system(size: 12)
        }
    }

    private func foregroundFor(level: Int) -> Color {
        level >= 3 ? .secondary : .primary
    }
}
