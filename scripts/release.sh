#!/usr/bin/env bash
#
# Cuts a release. Three artifacts go out, because there are three ways to
# install this and only one of them assumes the user has Node:
#
#   npm            the tag push triggers .github/workflows/release.yml (OIDC)
#   .mcpb          one-click bundle for Claude Desktop, runs on its own Node
#   binaries       standalone, signed and notarized on macOS
#
# The signed artifacts are the reason this is a local script rather than a
# workflow: the Developer ID certificate lives on one machine and never goes
# near CI. Everything that can fail — building, signing, Apple's notarization
# service — happens BEFORE the tag is pushed, so a failure leaves nothing
# published and nothing to clean up but an uncommitted version bump.
#
#   ./scripts/release.sh           patch bump (0.1.0 -> 0.1.1)
#   ./scripts/release.sh 1.1.0     set an explicit version
#   YES=1 ./scripts/release.sh     skip the confirmation prompt
#   SKIP_NOTARIZE=1 ./scripts/…    sign but do not notarize (testing only)
#   SKIP_BINARIES=1 ./scripts/…    npm + .mcpb only, no compiled binaries
#
# Notarization credentials are read from the environment by
# scripts/sign-and-notarize.sh — see the header there.
#
# Normally invoked as `make release` / `make release 1.1.0`.

set -euo pipefail

cd "$(dirname "$0")/.."

PKG="@engine-room/after-effects-mcp"
MANIFEST="packages/mcp-server/package.json"
DIST="dist-release"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- preflight
command -v git >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required"
command -v gh >/dev/null || die "the GitHub CLI is required to create the release page: https://cli.github.com"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated — run: gh auth login"
command -v zip >/dev/null || die "zip is required to package the .mcpb"

if [ "${SKIP_BINARIES:-}" != "1" ]; then
  command -v bun >/dev/null || die "bun is required to compile the standalone binaries (or set SKIP_BINARIES=1): https://bun.sh"
  [ "$(uname)" = "Darwin" ] || die "the macOS binaries are signed on a Mac; run this there, or set SKIP_BINARIES=1"
  if [ "${SKIP_NOTARIZE:-}" != "1" ]; then
    [ -n "${AE_MCP_NOTARY_PROFILE:-}${AE_MCP_NOTARY_KEY_ID:-}" ] \
      || die "no notarization credentials in the environment — see scripts/sign-and-notarize.sh (or set SKIP_NOTARIZE=1)"
  fi
  security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application" \
    || die "no Developer ID Application certificate in the keychain"
fi

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
printf 'Artifacts: npm package, .mcpb bundle'
[ "${SKIP_BINARIES:-}" != "1" ] && printf ', signed macOS binaries, unsigned Windows binary'
printf '\n\n'
if [ "${YES:-}" != "1" ]; then
  printf 'Tagging %s pushes to origin, publishes to npm and creates a public GitHub release. Continue? [y/N] ' "$TAG"
  read -r reply </dev/tty
  case "$reply" in [yY]*) ;; *) echo "Aborted."; exit 1 ;; esac
fi

# ------------------------------------------------------------------- bump
step "Setting version to $VERSION"
npm version "$VERSION" --workspace "$PKG" --no-git-tag-version >/dev/null
node scripts/sync-version.mjs

step "Building"
npm run build >/dev/null

# The release cut nothing but a build until now, and trusted that CI had been
# green on main beforehand. That trust was misplaced twice over: ci.yml ran only
# some of the suites, and a release can be cut from a main whose last CI run
# predates the commit being released. Tests are cheap, they need no After
# Effects, and this is still on the safe side of the tag.
step "Running the tests"
npm test >/dev/null || die "tests failed — nothing has been tagged or pushed"

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

# --------------------------------------------------------------- artifacts
# Everything that can fail happens here, before anything is published. A failed
# notarization at this point costs a `git checkout -- .` and nothing else.
rm -rf "$DIST"

step "Building the Claude Desktop bundle"
node scripts/build-mcpb.mjs --out "$DIST"

if [ "${SKIP_BINARIES:-}" != "1" ]; then
  step "Compiling standalone binaries"
  node scripts/build-binaries.mjs --out "$DIST"

  step "Signing and notarizing"
  ./scripts/sign-and-notarize.sh "$DIST"
fi

# The staging folders are inputs to the zips; only the archives get uploaded.
ASSETS=()
while IFS= read -r f; do ASSETS+=("$f"); done < <(find "$DIST" -maxdepth 1 -type f \( -name '*.zip' -o -name '*.mcpb' \) | sort)
[ ${#ASSETS[@]} -gt 0 ] || die "no release assets were produced in $DIST"
step "Release assets"
for a in "${ASSETS[@]}"; do printf '    %s\n' "$a"; done

# ------------------------------------------------------------------ commit
step "Committing and tagging"
git add -A
git commit --quiet -m "release: $VERSION"
git tag -a "$TAG" -m "$VERSION"

step "Pushing"
git push --quiet origin main
git push --quiet origin "$TAG"

REPO=$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')

# ----------------------------------------------------------------- release
# Created after the tag is pushed so it attaches to a ref that exists. The npm
# publish is running in parallel in Actions; the two are independent.
step "Creating the GitHub release"
NOTES=$(cat <<EOF
## Install

**Claude Desktop** — download \`after-effects-mcp-$VERSION.mcpb\` below and open it. Nothing else to install.

**Any other MCP client** — either \`npx -y @engine-room/after-effects-mcp\` if you have Node 22+, or download the
standalone build for your machine below and point your client at the executable inside it.

Then open After Effects and ask your assistant to set up After Effects.

## Notes

The macOS builds are signed and notarized. The Windows build is unsigned — SmartScreen may warn on first run.
Keep each downloaded folder together: the After Effects panel ships alongside the executable.

Full changelog: https://github.com/$REPO/compare/v$CURRENT...$TAG
EOF
)
gh release create "$TAG" "${ASSETS[@]}" \
  --repo "$REPO" \
  --title "$TAG" \
  --notes "$NOTES"

cat <<EOF

Released $TAG.

  Release   https://github.com/$REPO/releases/tag/$TAG
  Actions   https://github.com/$REPO/actions
  Package   https://www.npmjs.com/package/$PKG

The GitHub release is up with its assets. The npm publish runs in Actions via
OIDC and takes a few minutes; watch it with:  gh run watch
EOF
