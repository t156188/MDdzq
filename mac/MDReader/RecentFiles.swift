import Foundation

extension Notification.Name {
    static let mdreaderRecentsChanged = Notification.Name("mdreader.recentsChanged")
}

/// Application-wide list of recently opened markdown files. Stored in
/// UserDefaults so every DocumentGroup window sees the same list. Order is
/// newest-first, capped at `maxCount`.
enum RecentFiles {
    static let defaultsKey = "mdreader.recentFiles"
    static let maxCount = 12

    static func read() -> [String] {
        UserDefaults.standard.stringArray(forKey: defaultsKey) ?? []
    }

    static func add(_ path: String) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var list = read()
        list.removeAll { $0 == trimmed }
        list.insert(trimmed, at: 0)
        if list.count > maxCount { list = Array(list.prefix(maxCount)) }
        UserDefaults.standard.set(list, forKey: defaultsKey)
        NotificationCenter.default.post(name: .mdreaderRecentsChanged, object: nil)
    }

    /// Drop entries whose target no longer exists. Cheap to do — we only ever
    /// keep `maxCount` paths.
    static func prune() {
        let list = read()
        let alive = list.filter { FileManager.default.fileExists(atPath: $0) }
        if alive.count != list.count {
            UserDefaults.standard.set(alive, forKey: defaultsKey)
            NotificationCenter.default.post(name: .mdreaderRecentsChanged, object: nil)
        }
    }

    static func payloadJSON() -> String {
        let list = read()
        guard let data = try? JSONSerialization.data(withJSONObject: list, options: []),
              let json = String(data: data, encoding: .utf8) else { return "[]" }
        return json
    }
}
