# MacPlay Video

Experimental native CarPlay Video for macOS, forked from
[Roylyl/MacPlay 1.2.2](https://github.com/Roylyl/MacPlay/tree/575d885).
The iPhone sends a media URL and playback controls; **the Mac itself loads and
decodes the video using AVPlayer**. The ordinary CarPlay interface remains available.

**Experimental:** automated tests do not establish physical iPhone compatibility.
FairPlay-protected streaming services are unsupported.

## Install and try

Download from this fork's [preview releases](https://github.com/WilliamSung82/MacPlay/releases)
or a successful [macOS build](https://github.com/WilliamSung82/MacPlay/actions/workflows/video-preview.yml).
The upstream MacPlay release does not contain this feature.

| Mac | File |
| --- | --- |
| Apple Silicon (M-series) | `MacPlay-Video-1.2.2-preview-arm64.zip` |
| Intel | `MacPlay-Video-1.2.2-preview-x86_64.zip` |

1. Requires **macOS 14 or later**. Unzip and move **MacPlay Video.app** to Applications.
2. Open the app. It is locally signed without Apple notarization. If macOS blocks
   it, use **System Settings → Privacy & Security → Open Anyway**.
3. For the first test, connect the iPhone by USB, unlock it, trust the Mac, select
   **Wired CarPlay**, and start reception. Confirm ordinary CarPlay works first.
4. Open **Display → CarPlay Video** and enable **Native video (experimental desktop test)**.
   Apply and reconnect the iPhone to negotiate the capability.
5. Play an ordinary, unprotected video in a compatible iPhone app and choose
   **MacPlay Video** in its AirPlay output menu. A Safari video is a useful first
   test; support depends on the phone's OS and the app.
6. Use the iPhone or the Mac's player controls. **Back to CarPlay** pauses the movie
   and returns to the CarPlay window without disconnecting.

The option is off by default. It permits stationary desktop testing; it is not a
vehicle gear sensor. Turning it off immediately stops native video.

For wireless CarPlay, join the Mac and iPhone to the same Wi-Fi with device-to-device
traffic allowed. Select Wireless CarPlay, enter the network name/password, pair the
iPhone with the Mac through Bluetooth settings, choose that phone and start reception.

## Implementation

- Opt-in video capability, encrypted settings and remote-control channels.
- Queue insertion, play/pause, seek, playback information and property responses.
- MP4 and HLS through AVPlayer/AVKit, including phone resource loading for app URLs.
- Cancellation on stop, replacement, disconnect and feature disable.
- Separate settings in `~/Library/Application Support/MacPlay Video`.

FairPlay, offline HLS, SharePlay and interstitials are unsupported. Native video uses
the Mac's system audio output with the app's volume/mute setting.
See [design, provenance and validation](docs/carplay-video.md).

## Build and test

Engine checks run on Windows, Linux or macOS:

```sh
npx --yes pnpm@10.11.0 install --frozen-lockfile --ignore-scripts
npx --yes pnpm@10.11.0 run build:engine
npx --yes pnpm@10.11.0 test
```

Build the preview on a Mac with Xcode command-line tools:

```sh
bash scripts/build-video-preview.sh arm64  # or x86_64
```

This rebuilds the Swift application and TypeScript engine and reuses the unchanged
USB/Bluetooth, GStreamer and Node runtime from the SHA-256-pinned upstream V1.2.2
release. `VIDEO-BUILD.json` inside the app records the source commit and runtime.
No local user profile is read by the build.

For a complete native runtime rebuild, follow the dependencies in the
[original README](README.zh-CN.md) and run `pnpm run build`.

## License

GPL-3.0-or-later. Original copyright and component notices remain in
[LICENSE](LICENSE), [NOTICE](NOTICE) and [CREDITS](CREDITS.md). Protocol work derives
from [DiPlay](https://github.com/shihabal3amri/DiPlay) and the
[WinPlay video fork](https://github.com/WilliamSung82/WinPlay/tree/feature/carplay-video).
The experimental accessory authentication is the published upstream material;
it does not provide licensed FairPlay playback or imply Apple certification.

[Original Chinese README](README.zh-CN.md) · [Upstream changelog](CHANGELOG.md)
