#!/usr/bin/env bash
# Pre-push gate: lefthook script, runs on every push (see lefthook.yml).
set -euo pipefail
exec node scripts/check-lockfile-cooldown.mjs --pre-push
