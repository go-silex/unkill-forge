#!/usr/bin/env bash
# Pre-push gate: lefthook script, runs on every push (see lefthook.yml).
set -euo pipefail
node --test scripts/*.node-test.mjs && ./node_modules/.bin/vitest run --coverage &&
  node scripts/check-coverage-floors.mjs
