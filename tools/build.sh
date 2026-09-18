#!/usr/bin/env bash
# Export the Web build to dist/web.
#
#   tools/build.sh            # release
#   VARIANT=debug tools/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."

GODOT="${GODOT:-/Applications/Godot.app/Contents/MacOS/Godot}"
VARIANT="${VARIANT:-release}"
OUT="${OUT:-dist/web}"

if [ ! -x "$GODOT" ]; then
  echo "Godot not found at $GODOT - set GODOT=/path/to/Godot" >&2
  exit 1
fi

# The Web export templates are a one-time editor install:
#   Editor > Manage Export Templates > Download and Install
# Godot stores them somewhere different on each OS, so resolve the path rather
# than hardcoding the macOS one -- otherwise this reports "not installed" on
# Windows and Linux even when they are, which blames the creator's install for
# a path bug here.
case "$(uname -s)" in
  Darwin) TEMPLATES="$HOME/Library/Application Support/Godot/export_templates" ;;
  Linux)  TEMPLATES="${XDG_DATA_HOME:-$HOME/.local/share}/godot/export_templates" ;;
  *)      TEMPLATES="${APPDATA:-$HOME/AppData/Roaming}/Godot/export_templates" ;;
esac
TEMPLATES="${GODOT_TEMPLATES:-$TEMPLATES}"

if ! find "$TEMPLATES" -name 'web_nothreads_release.zip' -print -quit 2>/dev/null | grep -q .; then
  echo "Web export templates not found under $TEMPLATES" >&2
  echo "Install them: Editor > Manage Export Templates > Download and Install." >&2
  echo "If they live elsewhere, set GODOT_TEMPLATES=/path/to/export_templates." >&2
  exit 1
fi

# A fresh clone has no .godot/ import cache, and exporting without one produces
# a pack with no textures or audio in it.
if [ ! -d .godot/imported ]; then
  echo "==> importing assets"
  "$GODOT" --headless --import --path . >/dev/null 2>&1 || true
fi

rm -rf "$OUT"
mkdir -p "$OUT"

echo "==> exporting ($VARIANT)"
if [ "$VARIANT" = "debug" ]; then
  "$GODOT" --headless --export-debug "Web" "$OUT/index.html"
else
  "$GODOT" --headless --export-release "Web" "$OUT/index.html"
fi

# Exporting icons into a folder inside the project makes the editor re-import
# them on its next run; they are not part of the upload.
rm -f "$OUT"/*.import

echo "wrote $OUT"
