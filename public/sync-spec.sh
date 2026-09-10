#!/usr/bin/env sh
# sync-spec.sh — refresh the shared NC Futures platform files from the design-spec repo.
#
# Run it from the folder in your app that holds styles.css; fonts/ is created
# beside it. Downloads the current styles.css, fonts/, logo.svg and favicon.png
# from the spec repo's main branch, plus the shared CLAUDE.md — the house
# rules for how Claude works in every app — which goes to the repo root (that
# is where Claude reads it), replacing whatever was there. It refreshes files,
# not code: markup changes the spec asks for (company cell, toolbar, switcher,
# sort headers) still need reading the spec.
#
# Usage:            sh sync-spec.sh
# Private repo:     SPEC_REPO_TOKEN=... sh sync-spec.sh   (not needed while the repo is public;
#                   deliberately not GITHUB_TOKEN, which CI and hosted shells often set to
#                   a token that raw.githubusercontent.com rejects with a 404)
set -eu

BASE="https://raw.githubusercontent.com/github031524/Finance-Platform-Design-Spec/main"
FILES="styles.css logo.svg favicon.png fonts/Inter-Regular.woff2 fonts/Inter-Medium.woff2 fonts/Inter-SemiBold.woff2 fonts/LICENSE.txt"
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || echo .)   # the app's repo root; here if not a git repo

# fetch <path in spec repo> [<destination>]
fetch() {
  dst="${2:-$1}"
  mkdir -p "$(dirname "$dst")"
  if [ -n "${SPEC_REPO_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: Bearer $SPEC_REPO_TOKEN" "$BASE/$1" -o "$dst.tmp"
  else
    curl -fsSL "$BASE/$1" -o "$dst.tmp"
  fi
  mv "$dst.tmp" "$dst"   # only replace the file once the download finished
  echo "  $dst"
}

echo "Refreshing platform files from the spec repo:"
for f in $FILES; do fetch "$f"; done
fetch CLAUDE.md "$ROOT/CLAUDE.md"
echo "Done. Re-check the app's markup against the spec — this script copies files, not code."
