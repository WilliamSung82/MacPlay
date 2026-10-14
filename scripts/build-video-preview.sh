#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64) SHA=619f74f31ef9f60b2d7c257ca2a49e708b44eb254c172b44fa889017d126eb6a ;;
  x86_64) SHA=601347ef89afad6480c3e42143fd4ed5b23d6fe462dfb19df0485e84beac3c29 ;;
  *) echo 'Expected arm64 or x86_64' >&2; exit 1 ;;
esac
# Reuse the unchanged upstream USB/Bluetooth/GStreamer/Node runtime. The entire
# Swift app and TypeScript engine are compiled from this checkout. No host data
# or credentials are read. Upstream release inputs are pinned by SHA-256.
STAGE="$PWD/build/video-preview-$ARCH"
mkdir -p "$STAGE" dist
DMG="$STAGE/upstream.dmg"
if [[ ! -f "$DMG" ]]; then
  curl -fL --retry 3 'https://github.com/Roylyl/MacPlay/releases/download/V1.2.2/MacPlay-1.2.2-'"$ARCH"'.dmg' -o "$DMG"
fi
printf '%s  %s\n' "$SHA" "$DMG" | shasum -a 256 -c -
MOUNT="$STAGE/mount"
mkdir -p "$MOUNT"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$DMG"
trap 'hdiutil detach -quiet "$MOUNT" || true' EXIT
APP="$STAGE/MacPlay Video.app"
ditto "$MOUNT/MacPlay.app" "$APP"
hdiutil detach -quiet "$MOUNT"
trap - EXIT
swiftc -parse-as-library -O -target "$ARCH-apple-macosx14.0" \
  -framework SwiftUI -framework AppKit -framework CoreWLAN -framework CoreLocation \
  -framework IOKit -framework IOBluetooth -framework CoreAudio -framework MediaPlayer \
  -framework AVKit -framework AVFoundation \
  native/App/MacPlay.swift native/App/ApplicationLifecycle.swift native/App/About.swift \
  native/App/Localization.swift native/App/ConnectionPolicy.swift native/App/NowPlayingState.swift \
  native/App/NowPlayingFeed.swift native/App/NativeVideoPlayer.swift \
  -o "$APP/Contents/MacOS/MacPlay"
node node_modules/typescript/bin/tsc -p native/Engine/tsconfig.json
ditto build/engine "$APP/Contents/Resources/engine"
cp LICENSE NOTICE "$APP/Contents/Resources/"
mkdir -p "$APP/Contents/Resources/video-docs"
cp docs/carplay-video.md "$APP/Contents/Resources/video-docs/"
python3 - "$APP" "$(git rev-parse HEAD)" "$ARCH" "$SHA" <<'PY'
import sys, plistlib, json
from pathlib import Path
app=Path(sys.argv[1]); p=app/'Contents/Info.plist'
with p.open('rb') as f: info=plistlib.load(f)
info.update(CFBundleIdentifier='io.github.williamsung82.macplay.video', CFBundleName='MacPlay Video', CFBundleDisplayName='MacPlay Video', CFBundleVersion='37')
info['NSAppTransportSecurity']={'NSAllowsLocalNetworking':True,'NSAllowsArbitraryLoadsForMedia':True}
with p.open('wb') as f: plistlib.dump(info,f)
receiver=app/'Contents/Resources/runtime/MacPlayReceiver.app/Contents/Info.plist'
with receiver.open('rb') as f: info=plistlib.load(f)
info.update(CFBundleIdentifier='io.github.williamsung82.macplay.video.receiver',CFBundleName='MacPlay Video')
with receiver.open('wb') as f: plistlib.dump(info,f)
manifest={'source':'https://github.com/WilliamSung82/MacPlay','commit':sys.argv[2], 'architecture':sys.argv[3],
          'upstreamRuntime':'Roylyl/MacPlay V1.2.2','upstreamDmgSha256':sys.argv[4],
          'rebuilt':['Swift application','TypeScript engine'],
          'physicalIPhoneNativeVideoVerified':False}
(app/'Contents/Resources/VIDEO-BUILD.json').write_text(json.dumps(manifest,indent=2)+'\n')
PY
lipo "$APP/Contents/MacOS/MacPlay" -verify_arch "$ARCH"
lipo "$APP/Contents/Resources/runtime/MacPlayReceiver.app/Contents/MacOS/MacPlayReceiver" -verify_arch "$ARCH"
codesign --force --deep --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/MacPlay-Video-1.2.2-preview-$ARCH.zip"
shasum -a 256 "dist/MacPlay-Video-1.2.2-preview-$ARCH.zip" > "dist/MacPlay-Video-1.2.2-preview-$ARCH.zip.sha256"
