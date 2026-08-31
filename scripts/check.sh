#!/bin/sh
# Type-check and test the server. TypeScript and @types/node are dev tools only:
# installed into ~/.cache/ledge-check, never into the repo, never shipped.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOOLS=${LEDGE_CHECK_TOOLS:-$HOME/.cache/ledge-check}
if [ ! -x "$TOOLS/node_modules/.bin/tsc" ]; then
  mkdir -p "$TOOLS"
  (cd "$TOOLS" && npm init -y >/dev/null 2>&1 && npm install --silent --no-audit --no-fund typescript @types/node >/dev/null)
fi
cd "$ROOT"
"$TOOLS/node_modules/.bin/tsc" -p tsconfig.json --typeRoots "$TOOLS/node_modules/@types"
node --test server/*.test.mts
