#!/usr/bin/env bash
#
# Cuts a release: bumps the version everywhere, verifies the package, then
# pushes a tag. Pushing the tag is what triggers .github/workflows/release.yml,
# which publishes to npm via OIDC.
#
#   ./scripts/release.sh           patch bump (0.1.0 -> 0.1.1)
#   ./scripts/release.sh 1.1.0     set an explicit version
#   YES=1 ./scripts/release.sh     skip the confirmation prompt
#
# Normally invoked as `make release` / `make release 1.1.0`.

set -euo pipefail

cd "$(dirname "$0")/.."

PKG="@engine-room/after-effects-mcp"
MANIFEST="packages/mcp-server/package.json"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- preflight
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "main" ] || die "releases are cut from main; you are on '$BRANCH'"

[ -z "$(git status --porcelain)" ] || die "working tree is dirty — commit or stash first"

step "Fetching origin"
git fetch --quiet origin main --tags
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse @{u})
BASE=$(git merge-base @ @{u})
if [ "$LOCAL" != "$REMOTE" ]; then
  [ "$LOCAL" = "$BASE" ] && die "main is behind origin/main — pull first"
  [ "$REMOTE" = "$BASE" ] || die "main and origin/main have diverged"
  # LOCAL ahead of REMOTE is fine; those commits go out with the release.
fi

# ---------------------------------------------------------------- version
CURRENT=$(node -p "require('./$MANIFEST').version")

if [ $# -gt 0 ] && [ -n "${1:-}" ]; then
  VERSION="${1#v}"
else
  VERSION=$(node -e '
    const [maj,min,pat] = process.argv[1].split(".").map(Number);
    console.log(`${maj}.${min}.${pat + 1}`);
  ' "$CURRENT")
fi

echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' \
  || die "'$VERSION' is not a valid semver version"

TAG="v$VERSION"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
git ls-remote --exit-code --tags origin "$TAG" >/dev/null 2>&1 && die "tag $TAG already exists on origin"

if npm view "$PKG@$VERSION" version >/dev/null 2>&1; then
  die "$PKG@$VERSION is already published — npm versions cannot be reused"
fi

printf '\n  %s  ->  \033[1m%s\033[0m\n\n' "$CURRENT" "$VERSION"
if [ "${YES:-}" != "1" ]; then
  printf 'Tagging %s pushes to origin and publishes to npm. Continue? [y/N] ' "$TAG"
  read -r reply </dev/tty
  case "$reply" in [yY]*) ;; *) echo "Aborted."; exit 1 ;; esac
fi

# ------------------------------------------------------------------- bump
step "Setting version to $VERSION"
npm version "$VERSION" --workspace "$PKG" --no-git-tag-version >/dev/null
node scripts/sync-version.mjs

step "Building"
npm run build >/dev/null

step "Verifying the package"
node scripts/sync-version.mjs --check
# Same guard the release workflow applies: npm silently rewriting the manifest
# (a dropped bin, for instance) must block the release, not warn about it.
OUT=$(npm publish --workspace "$PKG" --dry-run 2>&1)
if grep -qE "invalid and removed|auto-corrected" <<<"$OUT"; then
  echo "$OUT" >&2
  die "npm would rewrite the manifest on publish — fix $MANIFEST first"
fi
grep -q "$PKG@$VERSION" <<<"$OUT" || die "dry-run did not report $PKG@$VERSION"

# ------------------------------------------------------------------ commit
step "Committing and tagging"
git add -A
git commit --quiet -m "release: $VERSION"
git tag -a "$TAG" -m "$VERSION"

step "Pushing"
git push --quiet origin main
git push --quiet origin "$TAG"

REPO=$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')
cat <<EOF

Released $TAG.

  Actions   https://github.com/$REPO/actions
  Package   https://www.npmjs.com/package/$PKG

The release workflow builds, verifies the tarball, and publishes via OIDC.
It takes a few minutes; watch it with:  gh run watch
EOF
