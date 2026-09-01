#!/usr/bin/env bash
# Build the Web export and package the Creator Console upload ZIP.
#
#   tools/package.sh
#
# The console wants a self-contained archive whose ROOT is index.html, with
# meta.json beside it. Every generated asset is rebuilt first, so a ZIP can
# never contain art or audio that no longer matches its source.
set -euo pipefail
cd "$(dirname "$0")/.."

ZIP="dist/godot-minit-template.zip"
OUT="dist/web"

echo "==> regenerating assets"
node tools/gen-art.mjs   | tail -1
node tools/gen-audio.mjs | tail -2
node tools/gen-music.mjs | tail -2

echo "==> checking meta.json"
node tools/check-meta.mjs

rm -f "$ZIP"
./tools/build.sh >/dev/null

# meta.json and the notices must sit at the top level of the ZIP, next to
# index.html; the console reads meta.json from there to pre-fill the draft.
cp meta.json "$OUT/meta.json"
cp THIRD-PARTY-NOTICES.txt "$OUT/THIRD-PARTY-NOTICES.txt"

echo "==> packaging"
( cd "$OUT" && zip -qr "../../$ZIP" . -x '.*' -x '**/.*' )

echo "==> pre-flight"
listing=$(unzip -Z1 "$ZIP")
fail=0
for required in index.html index.js index.wasm index.pck meta.json THIRD-PARTY-NOTICES.txt; do
  grep -qx "$required" <<<"$listing" || { echo "MISSING at ZIP root: $required" >&2; fail=1; }
done

# Project sources must never ride along.
forbidden=$(grep -E '(^|/)(tools|scenes|scripts|addons|web|assets|\.godot)/|\.gd$|\.tscn$|\.tres$|\.import$|project\.godot$|export_presets\.cfg$' <<<"$listing" || true)
if [ -n "$forbidden" ]; then
  echo "FORBIDDEN entries in ZIP:" >&2; echo "$forbidden" >&2; fail=1
fi

# The export contract, checked at the two points where it silently breaks.
unzip -p "$ZIP" index.html | grep -q '"canvasResizePolicy":2' \
  || { echo "index.html does not carry canvasResizePolicy 2 - the canvas stops following the host frame." >&2; fail=1; }
# A threaded build needs COOP/COEP headers the Minit host does not send, so it
# would simply fail to boot in the app. Check the flag the loader itself reads --
# index.js mentions SharedArrayBuffer either way, in its feature-detection
# messages, so grepping for that name is a false positive.
unzip -p "$ZIP" index.html | grep -q 'GODOT_THREADS_ENABLED = false' \
  || { echo "This is a THREADED build - it cannot boot in the Minit app. Set variant/thread_support=false." >&2; fail=1; }

# The shell is what carries BOTH audio fixes. If the export dropped it, the game
# goes silent inside the Minit app and nowhere else - exactly the bug that no
# local check catches.
unzip -p "$ZIP" index.html | grep -q 'AudioWorklet.prototype.addModule' \
  || { echo "index.html has lost the AudioWorklet fallback." >&2; fail=1; }
unzip -p "$ZIP" index.html | grep -q 'DROP-8164' \
  || { echo "index.html has lost the postMessage origin repair (DROP-8164)." >&2; fail=1; }
unzip -p "$ZIP" index.html | grep -q 'minit-audio' \
  || { echo "index.html has lost the audio context/gain recovery." >&2; fail=1; }

if unzip -p "$ZIP" index.html | grep -qE 'localStorage|sessionStorage'; then
  echo "index.html touches web storage, which the platform forbids." >&2
  fail=1
fi

size_bytes=$(stat -f%z "$ZIP")
if [ "$size_bytes" -gt 52428800 ]; then
  echo "ZIP is $(( size_bytes / 1048576 )) MB - over Minit's 50 MB hard limit." >&2
  fail=1
elif [ "$size_bytes" -gt 5242880 ]; then
  echo "note: ZIP is $(( size_bytes / 1048576 )) MB - over the 5 MB recommendation." >&2
fi

[ "$fail" -eq 0 ] || { echo "pre-flight failed - not shipping this" >&2; exit 1; }

echo
echo "wrote $ZIP ($(du -h "$ZIP" | cut -f1))"
unzip -l "$ZIP" | tail -n +4 | head -12
echo
echo "Upload $ZIP at https://console.minit.games"
