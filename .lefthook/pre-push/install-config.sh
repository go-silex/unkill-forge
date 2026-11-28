#!/usr/bin/env bash
# Pre-push gate: lefthook script, runs on every push (see lefthook.yml).
set -euo pipefail
exec node scripts/check-install-config.mjs
