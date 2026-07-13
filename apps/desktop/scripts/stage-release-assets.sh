#!/usr/bin/env bash
set -euo pipefail

target=${1:?Rust target is required}
bundle_root="apps/desktop/src-tauri/target/$target/release/bundle"
output="apps/desktop/release-assets/$target"
mkdir -p "$output"

while IFS= read -r -d '' artifact; do
  name=$(basename "$artifact")
  cp "$artifact" "$output/traicer-$target-$name"
done < <(
  find "$bundle_root" -type f \( \
    -name '*.dmg' -o \
    -name '*.deb' -o \
    -name '*.AppImage' -o \
    -name '*.msi' -o \
    -name '*.exe' -o \
    -name '*.app.tar.gz' -o \
    -name '*.sig' \
  \) -print0
)

if ! find "$output" -type f -print -quit | grep -q .; then
  echo "No release assets were staged for $target" >&2
  exit 1
fi
