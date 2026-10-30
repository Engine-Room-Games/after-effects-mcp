#!/usr/bin/env bash
#
# Cuts a release. Three artifacts go out, because there are three ways to
# install this and only one of them assumes the user has Node:
#
#   npm            packed here, attached to the GitHub release; publishing the
#                  release triggers .github/workflows/release.yml, which
#                  publishes that exact tarball over OIDC
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
# Every artifact's After Effects panel is signed with a self-signed certificate
# (issue #182) so it loads without Adobe's PlayerDebugMode. The panel is signed
# ONCE, here, before the tag, and every artifact — npm tarball, .mcpb, binaries —
# carries that same signed folder, so all of them hold identical signatures. CI
# never signs: that would put Rosetta, a download and a timestamp server after
# the tag. That needs no setup: with AE_MCP_PANEL_CERT unset the signing uses a
# throwaway certificate. To sign with one persistent certificate instead, set
# AE_MCP_PANEL_CERT (a .p12 from `ZXPSignCmd -selfSignedCert`) and
# AE_MCP_PANEL_CERT_PASSWORD — see scripts/lib/panel-signing.mjs.
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

# The panel is signed in every artifact this script builds. `required` turns a
# missing certificate or a failed signing into a failed build here, before the
# tag. AE_MCP_SIGNED_PANEL is set once the panel has been signed (below).
export AE_MCP_PANEL_SIGN=required
export AE_MCP_PANEL_CERT="${AE_MCP_PANEL_CERT:-ephemeral}"
unset AE_MCP_SIGNED_PANEL
node scripts/lib/panel-signing.mjs plan || die "the panel signing configuration is not usable — see scripts/lib/panel-signing.mjs"
# Adobe ships ZXPSignCmd for macOS as an x86_64 binary only.
if [ "$(uname -m)" = "arm64" ]; then
  arch -x86_64 /usr/bin/true 2>/dev/null \
    || die "ZXPSignCmd (which signs the panel) is an Intel binary and needs Rosetta: sudo softwareupdate --install-rosetta --agree-to-license"
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

node scripts/sync-version.mjs --check

# --------------------------------------------------------------- artifacts
# Everything that can fail happens here, before anything is published. A failed
# notarization at this point costs a `git checkout -- .` and nothing else.
rm -rf "$DIST"
mkdir -p "$DIST"

# One signing for the whole release (issue #182): every packaging step below
# copies this folder verbatim, so the npm, .mcpb and binary panels are
# byte-identical, signature included. The work folder (and with it nothing
# secret — an ephemeral certificate is deleted inside the signing) goes when
# the script exits.
SIGN_WORK=$(mktemp -d)
trap 'rm -rf "$SIGN_WORK"' EXIT
step "Signing the After Effects panel"
node scripts/lib/panel-signing.mjs sign "$SIGN_WORK/panel" || die "signing the panel failed — nothing has been tagged or pushed"
export AE_MCP_SIGNED_PANEL="$SIGN_WORK/panel"

# The npm tarball is packed HERE, not in CI, so the panel inside it is the one
# just signed and CI has nothing to sign or build. It is attached to the GitHub
# release, and release.yml publishes that exact file.
step "Packing the npm tarball"
npm pack --workspace "$PKG" --pack-destination "$DIST" >/dev/null
TARBALL="$DIST/engine-room-after-effects-mcp-$VERSION.tgz"
[ -f "$TARBALL" ] || die "npm pack did not produce $TARBALL"
# Same guard the release workflow applies: npm silently rewriting the manifest
# (a dropped bin, for instance) must block the release, not warn about it.
OUT=$(npm publish "$TARBALL" --dry-run --ignore-scripts 2>&1)
if grep -qE "invalid and removed|auto-corrected" <<<"$OUT"; then
  echo "$OUT" >&2
  die "npm would rewrite the manifest on publish — fix $MANIFEST first"
fi
grep -q "$PKG@$VERSION" <<<"$OUT" || die "dry-run did not report $PKG@$VERSION"

step "Building the Claude Desktop bundle"
node scripts/build-mcpb.mjs --out "$DIST"

if [ "${SKIP_BINARIES:-}" != "1" ]; then
  step "Compiling standalone binaries"
  node scripts/build-binaries.mjs --out "$DIST"

  step "Signing and notarizing"
  ./scripts/sign-and-notarize.sh "$DIST"
fi

# Nothing here had ever run an artifact before uploading it (issue #168). Each
# one is unpacked from the archive that will be uploaded, started over stdio,
# and must serve exactly the tools OpSchemas defines. Still before the tag: a
# bundle or binary that does not start costs a `git checkout -- .`, not a
# public release that has to be pulled.
step "Smoke-running the artifacts"
node scripts/lib/release-checks.mjs smoke-npm "$TARBALL" \
  || die "the npm tarball did not install and start cleanly — nothing has been tagged or pushed"
node scripts/lib/release-checks.mjs smoke-mcpb "$DIST/after-effects-mcp-$VERSION.mcpb" \
  || die "the .mcpb bundle did not start cleanly — nothing has been tagged or pushed"
if [ "${SKIP_BINARIES:-}" != "1" ]; then
  node scripts/lib/release-checks.mjs smoke-binaries "$DIST" \
    || die "a standalone binary did not start cleanly — nothing has been tagged or pushed"
fi

# The staging folders are inputs to the zips; only the archives get uploaded.
ASSETS=()
while IFS= read -r f; do ASSETS+=("$f"); done < <(find "$DIST" -maxdepth 1 -type f \( -name '*.zip' -o -name '*.mcpb' -o -name '*.tgz' \) | sort)
[ ${#ASSETS[@]} -gt 0 ] || die "no release assets were produced in $DIST"
step "Release assets"
for a in "${ASSETS[@]}"; do printf '    %s\n' "$a"; done

REPO=$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?#\1#')

# The tarball's digest goes into the annotated tag. release.yml reads it back
# from the tag and refuses to publish a downloaded asset that does not match
# it, so what reaches npm is provably the file smoke-run above — not whatever
# happens to be attached to the release by then.
TARBALL_SHA=$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)

# ------------------------------------------------------------------ commit
step "Committing and tagging"
git add -A
git commit --quiet -m "release: $VERSION"
git tag -a "$TAG" -m "$VERSION" -m "npm-tarball-sha256: $TARBALL_SHA"

# ----------------------------------------------------------------- release
# The release is created as a DRAFT before anything is pushed, with every asset
# uploaded: the upload is the slowest, flakiest step left, and as a draft it can
# fail with nothing public and nothing to undo but the draft itself. Publishing
# the draft after the push is what starts release.yml, which downloads the .tgz
# and publishes it to npm over OIDC — no build, no signing in CI.
step "Creating the GitHub release as a draft"
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
if ! gh release create "$TAG" "${ASSETS[@]}" \
  --repo "$REPO" \
  --title "$TAG" \
  --notes "$NOTES" \
  --draft; then
  gh release delete "$TAG" --repo "$REPO" --yes >/dev/null 2>&1 || true
  git tag -d "$TAG" >/dev/null
  git reset --quiet --soft HEAD~1
  die "creating the draft release failed — nothing has been pushed; the release commit and tag were undone locally"
fi

step "Pushing"
git push --quiet origin main
git push --quiet origin "$TAG"

step "Publishing the release"
if ! gh release edit "$TAG" --repo "$REPO" --draft=false; then
  cat >&2 <<EOF

The tag $TAG is pushed and the draft release holds every asset, but publishing
the draft failed, so npm has not been published yet. To finish, run:

  gh release edit $TAG --repo $REPO --draft=false

Publishing the draft starts release.yml, which publishes the attached tarball
(sha256 $TARBALL_SHA) to npm. Nothing needs rebuilding.
EOF
  exit 1
fi

cat <<EOF

Released $TAG.

  Release   https://github.com/$REPO/releases/tag/$TAG
  Actions   https://github.com/$REPO/actions
  Package   https://www.npmjs.com/package/$PKG

The GitHub release is up with its assets. Publishing it started the npm
publish in Actions, which uploads the attached tarball via OIDC and takes a
few minutes; watch it with:  gh run watch
EOF
