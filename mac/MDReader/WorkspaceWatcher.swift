import Foundation
import CoreServices

/// Recursive file-system watcher backed by FSEventStream. Emits a coalesced
/// list of changed paths per debounce window. The stream is started/stopped
/// from the owner — we never multiplex across roots.
final class WorkspaceWatcher {
    private var stream: FSEventStreamRef?
    private let queue = DispatchQueue(label: "mdreader.workspace-watcher")
    private var watchedRoot: URL?

    /// Called on the main queue with the deduped list of changed paths.
    var onChange: (([String]) -> Void)?

    init() {}

    deinit {
        stopUnsafe()
    }

    func watch(_ url: URL?) {
        // No-op if the root didn't change — avoids tearing down a healthy
        // stream when SwiftUI re-renders the host.
        if watchedRoot?.standardizedFileURL == url?.standardizedFileURL {
            return
        }
        stop()
        guard let url else { return }
        let paths: CFArray = [url.path] as CFArray
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let flags = UInt32(
            kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer
        )
        let callback: FSEventStreamCallback = { _, info, numEvents, eventPaths, _, _ in
            guard let info else { return }
            let me = Unmanaged<WorkspaceWatcher>.fromOpaque(info)
                .takeUnretainedValue()
            // eventPaths is documented as a CFArrayRef of CFString when the
            // file-events flag is set.
            let cfArr = Unmanaged<CFArray>.fromOpaque(eventPaths)
                .takeUnretainedValue()
            var collected: [String] = []
            collected.reserveCapacity(numEvents)
            let count = CFArrayGetCount(cfArr)
            for i in 0..<count {
                let raw = CFArrayGetValueAtIndex(cfArr, i)
                let str = Unmanaged<CFString>.fromOpaque(raw!).takeUnretainedValue()
                collected.append(str as String)
            }
            me.deliver(paths: collected)
        }
        guard let s = FSEventStreamCreate(
            kCFAllocatorDefault,
            callback,
            &context,
            paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.3, // latency seconds — FSEvents coalesces inside this window
            flags
        ) else { return }
        FSEventStreamSetDispatchQueue(s, queue)
        FSEventStreamStart(s)
        stream = s
        watchedRoot = url
    }

    func stop() {
        stopUnsafe()
        watchedRoot = nil
    }

    private func stopUnsafe() {
        if let s = stream {
            FSEventStreamStop(s)
            FSEventStreamInvalidate(s)
            FSEventStreamRelease(s)
            stream = nil
        }
    }

    private func deliver(paths: [String]) {
        let cb = onChange
        DispatchQueue.main.async {
            cb?(paths)
        }
    }
}
