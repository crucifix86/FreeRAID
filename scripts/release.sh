#!/usr/bin/env bash
# release.sh — Tag a new FreeRAID release and publish component tarball to GitHub
#
# Usage:
#   bash scripts/release.sh 0.1.1 "Fix parity sync on first boot"
#   bash scripts/release.sh 0.2.0 "Add Docker app manager"
#
# Requires: gh (GitHub CLI), git, tar

set -euo pipefail

VERSION="${1:-}"
NOTES="${2:-}"
REPO="crucifix86/FreeRAID"

[[ -z "$VERSION" ]] && { echo "Usage: $0 <version> [release notes]"; exit 1; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Version must be x.y.z format"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"

cd "$REPO_DIR"

echo "==> Releasing FreeRAID v${VERSION}"

# 1. Update VERSION file (this is the single source of truth)
echo "$VERSION" > VERSION

# 3. Build the component tarball — only the parts devices need to update
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

TARBALL_NAME="freeraid-components-${VERSION}.tar.gz"
STAGE="$TMPDIR/stage"
mkdir -p "$STAGE/web/freeraid"

# CLI (renamed to just 'freeraid' at root of tarball)
cp core/freeraid "$STAGE/freeraid"
chmod +x "$STAGE/freeraid"

# Importer
cp importer/unraid-import.py "$STAGE/unraid-import"
chmod +x "$STAGE/unraid-import"

# Web UI
cp web/freeraid/manifest.json \
   web/freeraid/index.html \
   web/freeraid/freeraid.css \
   web/freeraid/freeraid.js \
   "$STAGE/web/freeraid/"

# VERSION inside tarball so updater can verify
cp VERSION "$STAGE/VERSION"

echo "==> Building tarball: $TARBALL_NAME"
tar -czf "$TMPDIR/$TARBALL_NAME" -C "$STAGE" .

ls -lh "$TMPDIR/$TARBALL_NAME"

# 4. Commit version bump
git add VERSION core/freeraid
git commit -m "Release v${VERSION}" || echo "(nothing to commit for version bump)"

# 5. Tag
git tag -a "v${VERSION}" -m "FreeRAID v${VERSION}"
echo "==> Tagged v${VERSION}"

# 6. Push commits + tag
git push origin main
git push origin "v${VERSION}"

# 7. Create GitHub release and attach tarball
RELEASE_NOTES="${NOTES:-FreeRAID v${VERSION}}"

gh release create "v${VERSION}" \
    "$TMPDIR/$TARBALL_NAME" \
    --repo "$REPO" \
    --title "FreeRAID v${VERSION}" \
    --notes "$RELEASE_NOTES" \
    --verify-tag

echo ""
echo "==> Released: https://github.com/${REPO}/releases/tag/v${VERSION}"
echo "    Tarball:  $TARBALL_NAME ($(du -sh "$TMPDIR/$TARBALL_NAME" | cut -f1))"
echo ""
echo "    Devices update with:  freeraid update"
