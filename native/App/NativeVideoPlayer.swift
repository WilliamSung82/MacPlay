// SPDX-License-Identifier: GPL-3.0-or-later
import AppKit
import AVKit
import AVFoundation

/// The Mac is the video player. The iPhone supplies a media URL and playback controls.
/// AVPlayer sees only the engine's opaque, per-item HTTP proxy, never app URL schemes.
@MainActor final class NativeVideoPlayer: NSObject, NSWindowDelegate {
    private(set) var itemID: String?
    let player = AVPlayer()
    var presentsWindow = true
    private var panel: NSPanel?
    private var itemObservation: NSKeyValueObservation?
    private var rateObservation: NSKeyValueObservation?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var desiredPlaying = false
    private var pendingSeek: Double?
    private var failed = false
    var sendState: ((String, [String: Any]) -> Void)?
    var statusChanged: ((String) -> Void)?
    var showCarPlay: (() -> Void)?

    override init() {
        super.init()
        player.automaticallyWaitsToMinimizeStalling = true
        rateObservation = player.observe(\.rate, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                guard let self else { return }
                if self.pendingSeek == nil && self.player.currentItem?.status == .readyToPlay { self.desiredPlaying = self.player.rate > 0 }
                self.report()
            }
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 1000), queue: .main) { [weak self] _ in
            Task { @MainActor in self?.report() }
        }
    }

    func handle(_ message: [String: Any]) {
        guard let action = message["action"] as? String, let id = message["itemId"] as? String else { return }
        if action == "load" {
            stop()
            itemID = id
            guard let text = message["url"] as? String, let url = URL(string: text),
                  url.scheme == "http", url.host == "127.0.0.1", url.port != nil,
                  url.user == nil, url.password == nil, url.pathComponents.count == 3 else {
                fail("network"); return
            }
            desiredPlaying = false
            pendingSeek = finite(message["start"] as? Double ?? 0)
            let item = AVPlayerItem(url: url)
            itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
                Task { @MainActor in
                    guard let self, let item, self.itemID == id, self.player.currentItem === item else { return }
                    if item.status == .failed { self.fail((item.error as NSError?)?.domain == NSURLErrorDomain ? "network" : "unsupported") }
                    else if item.status == .readyToPlay {
                        if let seconds = self.pendingSeek { self.seek(seconds) }
                        else if self.desiredPlaying { self.player.play() }
                        self.report()
                    }
                }
            }
            endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.itemID == id else { return }
                    self.desiredPlaying = false; self.player.pause(); self.report()
                }
            }
            player.replaceCurrentItem(with: item)
            statusChanged?("Loading native video on this Mac")
            report()
            return
        }
        guard itemID == id else { return }
        // The engine sends stop in response to a decoder/network error as well.
        if action == "stop" { stop(); return }
        guard !failed else { return }
        switch action {
        case "rate":
            desiredPlaying = message["playing"] as? Bool == true
            if desiredPlaying {
                show()
                if player.currentItem?.status == .readyToPlay && pendingSeek == nil { player.play() }
            } else { player.pause() }
            report()
        case "seek": if let seconds = message["seconds"] as? Double { seek(finite(seconds)) }
        case "show": show()
        default: break
        }
    }

    func setAudio(volume: Double, enabled: Bool) {
        player.volume = Float(min(1, max(0, volume)))
        player.isMuted = !enabled
    }

    private func seek(_ seconds: Double) {
        pendingSeek = seconds
        guard player.currentItem?.status == .readyToPlay, let id = itemID else { return }
        player.seek(to: CMTime(seconds: seconds, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            Task { @MainActor in
                guard let self, self.itemID == id, self.pendingSeek == seconds, finished else { return }
                self.pendingSeek = nil
                if self.desiredPlaying { self.player.play() }
                self.report()
            }
        }
    }

    private func show() {
        guard itemID != nil, presentsWindow else { return }
        if panel == nil {
            let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 960, height: 580),
                                 styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            window.title = "MacPlay Video"
            window.hidesOnDeactivate = false
            window.isFloatingPanel = false
            window.isReleasedWhenClosed = false
            window.delegate = self
            window.contentMinSize = NSSize(width: 480, height: 310)
            let root = NSView()
            let view = AVPlayerView()
            view.player = player
            view.controlsStyle = .floating
            view.videoGravity = .resizeAspect
            view.allowsPictureInPicturePlayback = false
            let back = NSButton(title: "Back to CarPlay", target: self, action: #selector(backToCarPlay))
            for child in [view, back] as [NSView] { child.translatesAutoresizingMaskIntoConstraints = false; root.addSubview(child) }
            NSLayoutConstraint.activate([
                back.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
                back.topAnchor.constraint(equalTo: root.topAnchor, constant: 8),
                view.topAnchor.constraint(equalTo: back.bottomAnchor, constant: 8),
                view.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                view.trailingAnchor.constraint(equalTo: root.trailingAnchor),
                view.bottomAnchor.constraint(equalTo: root.bottomAnchor)
            ])
            window.contentView = root
            window.center()
            panel = window
        }
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    @objc private func backToCarPlay() { hideAndPause(); showCarPlay?() }
    func hideAndPause() { desiredPlaying = false; player.pause(); panel?.orderOut(nil); report() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { backToCarPlay(); return false }

    func stop() {
        itemID = nil; pendingSeek = nil; desiredPlaying = false; failed = false
        itemObservation?.invalidate(); itemObservation = nil
        if let observer = endObserver { NotificationCenter.default.removeObserver(observer); endObserver = nil }
        player.pause(); player.replaceCurrentItem(with: nil)
        panel?.orderOut(nil)
    }

    private func finite(_ value: Double) -> Double { value.isFinite ? max(0, value) : 0 }
    private func fail(_ error: String) {
        guard let id = itemID, !failed else { return }
        failed = true; desiredPlaying = false; player.pause()
        statusChanged?(error == "network" ? "Native video could not load its media" : "This media format or protection is unsupported")
        sendState?(id, ["error": error])
    }

    private func report() {
        guard let id = itemID, let item = player.currentItem, !failed else { return }
        let ready = item.status == .readyToPlay
        let playing = player.rate > 0 && ready
        let buffered = item.loadedTimeRanges.map { finite(CMTimeGetSeconds(CMTimeRangeGetEnd($0.timeRangeValue))) }.max() ?? 0
        sendState?(id, ["prepared": ready, "playing": playing,
                        "positionSeconds": finite(CMTimeGetSeconds(player.currentTime())),
                        "durationSeconds": finite(CMTimeGetSeconds(item.duration)), "bufferedSeconds": buffered])
        if ready { statusChanged?(playing ? "Playing native video on this Mac" : "Native video paused") }
    }
}
