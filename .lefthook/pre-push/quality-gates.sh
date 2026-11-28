#!/usr/bin/env bash
# Pre-push gate: lefthook script, runs on every push (see lefthook.yml).
set -euo pipefail
./node_modules/.bin/biome ci . && node scripts/check-file-length.mjs &&
  node scripts/check-worker-scope.mjs && ./node_modules/.bin/knip --no-progress &&
  ./node_modules/.bin/tsc --noEmit
