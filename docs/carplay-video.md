# Native CarPlay Video on the Mac

The Mac is the head unit and contains the player. The iPhone hands it a URL and
controls playback. Ordinary CarPlay stays on its existing GStreamer path; the
movie is decoded locally by AVPlayer in an AVKit window.

## Protocol and process boundaries

`videoInCar.ts`, `videoPlayback.ts` and `videoSettingsChannel.ts` implement the
observed protocol. `/info` advertises `videoPlaybackInfo` only when enabled. SETUP
acknowledges `videoPlayback` only when the phone proposes it. Availability is sent
on the encrypted event channel after the RECORD response and resent on reconnect.

The iAP tunnel remains stream 1. Encrypted video settings use stream 2; socketless
remote-control streams start at 3. Their teardown cannot tear down iAP. Commands
contain a binary plist in `params.data`, identified by `X-Apple-StreamID`. Commands
on both control and event connections are routed.

The engine owns media resources and phone `unhandledURL` requests. A loopback HTTP
server serves only resources registered for the current item, behind random opaque
paths. HLS child URLs are rewritten to that server. Byte ranges and redirects are
supported; local files, scripts, loopback source URLs and FairPlay `skd:` keys are
rejected. Pending downloads are canceled when the item ends. Signed media URLs are
excluded from diagnostics.

`NativeVideoBridge` sends only the proxy URL to Swift through the existing process
pipe. Immediate controls are retained while that URL is being prepared. Stale
item/session updates cannot control a newer movie. `NativeVideoPlayer` reports real
preparation, playback, position, duration and buffered-time state back to the engine.
Closing its window pauses and returns to CarPlay; disconnect releases the item.

The app permits AVFoundation HTTP media for its local proxy. Swift accepts only an
HTTP loopback URL from the engine; source URLs are validated/resolved in the engine.

## Verification boundaries

- Protocol tests cover opt-in, negotiation, encrypted framing, event reconnection,
  playback requests, phone URL resources, feature revocation and teardown.
- Bridge/proxy tests cover asynchronous control ordering, replacement, stale
  ownership, ranges, redirects, nested HLS, opaque tokens and URL restrictions.
- The macOS workflow builds and signs the actual Swift app on Apple Silicon and
  Intel. The player smoke test uses generated H.264/AAC MP4 and HLS and checks
  decoded 640×360 pixel buffers, timeline progress, seek to 4 seconds, pause and
  item release. Results accompany each successful artifact.

**Physical iPhone native-video playback remains unverified.** The smoke test's
resource loader simulates the phone. It does not prove OS/app negotiation or actual
phone resource delivery. The Display tab reports negotiation, loading and playback.

DRM/FairPlay, offline HLS, SharePlay, interstitials, integrated timelines and secure
stop are not advertised. Private cookies and unsupported codecs can prevent playback.
Live streams may have incomplete duration/range information in this initial adapter.
Native video uses the system audio output, with the app's media volume and mute.

## Reproducible preview

`scripts/build-video-preview.sh` pins the upstream V1.2.2 DMGs by SHA-256. It reuses
their unchanged native runtime, rebuilds all Swift and engine code, signs locally,
and embeds the source/runtime manifest. The workflow uploads the ZIP, checksum and
player result only after all checks succeed. No signing account, local profile or
private conversation content is used. Full native source builds remain available
through `scripts/build-macplay.sh` with its Rust/GStreamer SDK prerequisites.

## Provenance

Protocol and resource loader adapted from
[WinPlay at 6687fb2](https://github.com/WilliamSung82/WinPlay/tree/6687fb21742a0e214dfc87a352c03848a2233603),
derived from [DiPlay at 3f55401](https://github.com/shihabal3amri/DiPlay/tree/3f554012a5a60817ef18e3e4fcdb2ff9ed8a7069).
Relevant sources include `VideoInCar.kt`, `VideoSettingsChannel.kt`,
`AirPlaySession.kt`, `CarPlayMediaEngine.kt` and `CarPlayVideo.kt`. GPL notices are
retained. The Swift player and process bridge are additions in this fork.
