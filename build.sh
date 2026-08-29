#!/usr/bin/env bash
#
# Builds the plugin and packages it the way Jellyfin expects it.
#
#   ./build.sh            -> dist/Jellyfin.Plugin.Donate_1.0.0.0.zip
#   ./build.sh --install  -> also copies it into a local Jellyfin's plugin directory
#
set -euo pipefail

VERSION="1.0.0.0"
TARGET_ABI="10.11.0.0"
NAME="Jellyfin.Plugin.Donate"
GUID="b1f0a5c2-3d7e-4a91-9c5f-2e8d4a6b7c30"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$root/dist"
PLUGIN_DIR="Donations_$VERSION"   # the folder name Jellyfin expects on the server
stage="$out/$PLUGIN_DIR"

rm -rf "$out"
mkdir -p "$stage"

dotnet publish "$root/$NAME/$NAME.csproj" \
    --configuration Release \
    --output "$out/publish"

cp "$out/publish/$NAME.dll" "$stage/"

timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
checksum="$(md5sum "$stage/$NAME.dll" | cut -d' ' -f1)"

cat > "$stage/meta.json" <<META
{
    "category": "General",
    "guid": "$GUID",
    "name": "Donations",
    "description": "Asks users at login whether they would like to donate to whoever hosts the server, with a configurable donate page.",
    "overview": "Ask users to donate to the person hosting the server.",
    "owner": "you",
    "targetAbi": "$TARGET_ABI",
    "timestamp": "$timestamp",
    "version": "$VERSION",
    "changelog": "Initial release.",
    "imagePath": ""
}
META

(cd "$out" && zip -qr "$out/${NAME}_${VERSION}.zip" "$PLUGIN_DIR")
echo
echo "Upload this folder into your Jellyfin plugins directory, then restart Jellyfin:"
echo "    $stage/"
echo "Or the same thing zipped: $out/${NAME}_${VERSION}.zip"
echo "(dll md5 $checksum)"

if [[ "${1:-}" == "--install" ]]; then
    for dir in \
        "/var/lib/jellyfin/plugins" \
        "$HOME/.local/share/jellyfin/plugins" \
        "/config/plugins"
    do
        if [[ -d "$dir" ]]; then
            target="$dir/$PLUGIN_DIR"
            mkdir -p "$target"
            cp "$stage/$NAME.dll" "$stage/meta.json" "$target/"
            echo "Installed to $target - restart Jellyfin to load it."
            exit 0
        fi
    done
    echo "No Jellyfin plugin directory found; copy dist/$NAME/ there yourself." >&2
    exit 1
fi
