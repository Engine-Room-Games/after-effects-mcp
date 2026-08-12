#!/usr/bin/env bash
#
# Signs, notarizes and packages the release artifacts in dist-release/.
#
# Runs on a Mac with the signing certificate in the keychain — never in CI. The
# certificate is the one thing here that cannot be re-issued casually: if it
# leaks and someone signs malware with it, Apple revokes it and everything ever
# signed with it stops launching, including builds already on users' machines.
# So it stays on one machine, and nothing in this repo ever reads it.
#
# Credentials, from the environment:
#
#   AE_MCP_SIGN_IDENTITY   "Developer ID Application: Name (TEAMID)"
#                          (defaults to the only Developer ID in the keychain)
#   AE_MCP_NOTARY_PROFILE  a `notarytool store-credentials` profile name
#     — or —
#   AE_MCP_NOTARY_KEY_ID / AE_MCP_NOTARY_KEY_ISSUER / AE_MCP_NOTARY_KEY_PATH
#                          an App Store Connect API key (preferred over an
#                          Apple ID password: it is scoped and revocable)
#
# One-time setup for the profile form:
#   xcrun notarytool store-credentials ae-mcp --key … --key-id … --issuer …
#
# Usage: scripts/sign-and-notarize.sh [dist-release-dir]
# Set SKIP_NOTARIZE=1 to sign only (fast; produces artifacts macOS will still
# warn about on other machines).

set -euo pipefail

cd "$(dirname "$0")/.."
DIST="${1:-dist-release}"
ENTITLEMENTS="scripts/entitlements.plist"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
step() { printf '\033[1m==>\033[0m %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

[ "$(uname)" = "Darwin" ] || die "signing only runs on macOS"
[ -f "$DIST/binaries.json" ] || die "no $DIST/binaries.json — run: npm run build:binaries"
command -v xcrun >/dev/null || die "Xcode command line tools are required"

# ------------------------------------------------------------------ identity
IDENTITY="${AE_MCP_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY=$(security find-identity -v -p codesigning \
    | sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' | head -1)
  [ -n "$IDENTITY" ] || die "no Developer ID Application certificate in the keychain, and AE_MCP_SIGN_IDENTITY is not set"
fi
step "Signing as: $IDENTITY"

# ---------------------------------------------------------------- notary auth
NOTARY_ARGS=()
if [ "${SKIP_NOTARIZE:-}" = "1" ]; then
  note "SKIP_NOTARIZE=1 — signing without notarization"
elif [ -n "${AE_MCP_NOTARY_PROFILE:-}" ]; then
  NOTARY_ARGS=(--keychain-profile "$AE_MCP_NOTARY_PROFILE")
elif [ -n "${AE_MCP_NOTARY_KEY_ID:-}" ]; then
  [ -n "${AE_MCP_NOTARY_KEY_ISSUER:-}" ] || die "AE_MCP_NOTARY_KEY_ISSUER is required alongside AE_MCP_NOTARY_KEY_ID"
  [ -f "${AE_MCP_NOTARY_KEY_PATH:-}" ] || die "AE_MCP_NOTARY_KEY_PATH does not point at a .p8 key file"
  NOTARY_ARGS=(--key "$AE_MCP_NOTARY_KEY_PATH" --key-id "$AE_MCP_NOTARY_KEY_ID" --issuer "$AE_MCP_NOTARY_KEY_ISSUER")
else
  die "no notarization credentials. Set AE_MCP_NOTARY_PROFILE, or the three AE_MCP_NOTARY_KEY_* variables, or SKIP_NOTARIZE=1"
fi

VERSION=$(node -p "require('./$DIST/binaries.json').version")
COUNT=$(node -p "require('./$DIST/binaries.json').targets.length")

for i in $(seq 0 $((COUNT - 1))); do
  NAME=$(node -p "require('./$DIST/binaries.json').targets[$i].name")
  EXE=$(node -p "require('./$DIST/binaries.json').targets[$i].exe")
  SIGN=$(node -p "require('./$DIST/binaries.json').targets[$i].sign")
  STAGE_NAME=$(node -p "require('./$DIST/binaries.json').targets[$i].stageName")
  STAGE="$DIST/$STAGE_NAME"
  ZIP="$DIST/$STAGE_NAME.zip"

  [ -d "$STAGE" ] || die "missing $STAGE"

  if [ "$SIGN" != "true" ]; then
    step "$NAME — unsigned by design, packaging as-is"
    rm -f "$ZIP"
    # `zip` rather than ditto: this one is unpacked on Windows.
    (cd "$DIST" && zip -r -q -X "$STAGE_NAME.zip" "$STAGE_NAME" -x '*.DS_Store')
    note "$ZIP"
    continue
  fi

  step "$NAME — signing"
  codesign --force --timestamp --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --sign "$IDENTITY" \
    "$STAGE/$EXE"
  codesign --verify --strict --verbose=1 "$STAGE/$EXE"
  note "signature verified"

  # ditto, not zip: it is the archiver Apple's own tooling expects, and it
  # preserves the signature and extended attributes that `zip` drops.
  rm -f "$ZIP"
  /usr/bin/ditto -c -k --keepParent "$STAGE" "$ZIP"

  if [ "${SKIP_NOTARIZE:-}" = "1" ]; then
    note "$ZIP (not notarized)"
    continue
  fi

  step "$NAME — notarizing (Apple's scan usually takes 1-5 minutes)"
  xcrun notarytool submit "$ZIP" "${NOTARY_ARGS[@]}" --wait

  # A bare Mach-O executable cannot carry a stapled ticket — stapler only writes
  # into bundle formats (.app/.pkg/.dmg). Gatekeeper falls back to checking
  # Apple's service online the first time the binary runs, which is fine for a
  # tool the user's MCP client launches on a networked machine, and is why the
  # zip is notarized rather than the binary being stapled.
  note "notarized; Gatekeeper will verify online on first launch (bare binaries cannot be stapled)"
  note "$ZIP"
done

# The .mcpb is a plain zip that Claude Desktop unpacks itself; it is not
# executed by macOS directly and so is not subject to Gatekeeper.
MCPB="$DIST/after-effects-mcp-$VERSION.mcpb"
[ -f "$MCPB" ] && note "$MCPB (no signing required)"

step "Done"
ls -lh "$DIST"/*.zip "$DIST"/*.mcpb 2>/dev/null | awk '{printf "    %-12s %s\n", $5, $9}'
