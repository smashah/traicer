#!/usr/bin/env bash
set -euo pipefail

root=${1:-release-artifacts}
tag=${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}
version=${tag##*@}
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
published_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

manifest=$(jq -n \
  --arg version "$version" \
  --arg pub_date "$published_at" \
  '{version: $version, notes: "See the signed GitHub release notes.", pub_date: $pub_date, platforms: {}}')

add_platform() {
  local platform=$1
  local target=$2
  local pattern=$3
  local artifact
  artifact=$(find "$root/traicer-$target" -type f -name "$pattern" ! -name '*.sig' | head -n 1)
  if [[ -z "$artifact" || ! -f "$artifact.sig" ]]; then
    echo "Missing updater artifact or signature for $platform" >&2
    exit 1
  fi
  local name
  name=$(basename "$artifact")
  local signature
  signature=$(<"$artifact.sig")
  local url="https://github.com/${repository}/releases/download/${tag}/${name}"
  manifest=$(jq \
    --arg platform "$platform" \
    --arg signature "$signature" \
    --arg url "$url" \
    '.platforms[$platform] = {signature: $signature, url: $url}' \
    <<<"$manifest")
}

add_platform darwin-aarch64 aarch64-apple-darwin '*.app.tar.gz'
add_platform darwin-x86_64 x86_64-apple-darwin '*.app.tar.gz'
add_platform linux-x86_64 x86_64-unknown-linux-gnu '*.AppImage'
add_platform windows-x86_64 x86_64-pc-windows-msvc '*-setup.exe'

jq . <<<"$manifest" > "$root/latest.json"
