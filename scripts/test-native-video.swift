import AppKit
import AVFoundation
import CoreVideo

enum SmokeError: Error { case failed(String) }

@main struct NativeVideoSmoke {
    @MainActor static func wait(_ description: String, until condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(30)
        while !condition() {
            if Date() > deadline { throw SmokeError.failed(description) }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }
    @MainActor static func main() async {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let controller = NativeVideoPlayer()
        controller.presentsWindow = false
        var state: [String: Any] = [:]
        controller.sendState = { _, value in state = value }
        var results: [[String: Any]] = []
        do {
            guard CommandLine.arguments.count == 3 else { throw SmokeError.failed("Expected MP4 and HLS proxy URLs") }
            for (index, url) in CommandLine.arguments.dropFirst().enumerated() {
                let id = "test-\(index)"
                state = [:]
                controller.handle(["action":"load", "itemId":id, "url":url, "start":0.0])
                let videoOutput = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
                controller.player.currentItem?.add(videoOutput)
                controller.handle(["action":"rate", "itemId":id, "playing":true])
                var size = [0, 0]
                try await wait("\(index == 0 ? "MP4" : "HLS") failed to decode and advance: \(state)") {
                    let time = controller.player.currentTime()
                    if let frame = videoOutput.copyPixelBuffer(forItemTime: time, itemTimeForDisplay: nil) {
                        size = [CVPixelBufferGetWidth(frame), CVPixelBufferGetHeight(frame)]
                    }
                    return state["prepared"] as? Bool == true && CMTimeGetSeconds(time) > 0.5 && size == [640, 360]
                }
                controller.handle(["action":"seek", "itemId":id, "seconds":4.0])
                try await wait("seek did not reach 4 seconds") { CMTimeGetSeconds(controller.player.currentTime()) >= 3.9 }
                controller.handle(["action":"rate", "itemId":id, "playing":false])
                let paused = CMTimeGetSeconds(controller.player.currentTime())
                try await Task.sleep(nanoseconds: 700_000_000)
                guard abs(CMTimeGetSeconds(controller.player.currentTime()) - paused) < 0.1 else { throw SmokeError.failed("pause still advances") }
                guard state["playing"] as? Bool == false else { throw SmokeError.failed("pause feedback missing") }
                controller.handle(["action":"stop", "itemId":id])
                guard controller.player.currentItem == nil, controller.itemID == nil else { throw SmokeError.failed("stop did not release item") }
                results.append(["format": index == 0 ? "MP4" : "HLS", "decodedSize": size, "seek":true, "pause":true, "stop":true])
            }
            // Local files never reach AVPlayer, even through a malformed engine message.
            controller.handle(["action":"load", "itemId":"blocked", "url":"file:///etc/passwd"])
            guard state["error"] as? String == "network", controller.player.currentItem == nil else { throw SmokeError.failed("local file accepted") }
            let json = try JSONSerialization.data(withJSONObject: ["passed":true,"results":results], options: [.sortedKeys])
            print(String(decoding:json,as:UTF8.self)); exit(0)
        } catch {
            fputs("Native video smoke failed: \(error); state=\(state)\n", stderr)
            controller.stop(); exit(1)
        }
    }
}
