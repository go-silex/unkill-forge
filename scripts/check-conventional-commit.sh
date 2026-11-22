#!/usr/bin/env bash
# check-conventional-commit.sh — Conventional Commits sur le sujet d'un commit.
#
# Remplace `pr-title.yml` (retiré avec la CI de projects-meta, 2026-09-20) :
# la convention est tenue au **commit**, pas au titre de PR — un commit nu la
# respecte donc aussi. Liste de types identique à celle qu'acceptait
# `amannn/action-semantic-pull-request` dans l'ancien workflow.
#
# Réutilisable par n'importe quel repo de la flotte :
#   commit-msg:
#     commands:
#       conventional:
#         run: ~/projects/scripts/git-hooks/check-conventional-commit.sh {1}
#
# Exit : 0 = conforme (ou commit généré par git), 1 = non conforme.
set -euo pipefail

MSG_FILE="${1:?usage: check-conventional-commit.sh <commit-msg-file>}"
[ -f "$MSG_FILE" ] || { echo "check-conventional-commit: fichier introuvable: $MSG_FILE" >&2; exit 2; }

# Premier ligne non-commentaire = le sujet.
subject="$(sed -n '/^[^#]/{p;q;}' "$MSG_FILE")"

# Ce que git rédige lui-même passe sans discussion.
case "$subject" in
  "Merge "*|"Revert "*|"fixup! "*|"squash! "*|"") exit 0 ;;
esac

TYPES='feat|fix|refactor|docs|style|test|chore|ci|perf|build|revert'

if printf '%s' "$subject" | grep -qE "^(${TYPES})(\([a-zA-Z0-9._/-]+\))?!?: .+"; then
  exit 0
fi

{
  echo "commit-msg: sujet non conforme aux Conventional Commits"
  echo "  sujet : ${subject}"
  echo "  forme : <type>[(scope)][!]: <description non vide>"
  echo "  types : ${TYPES//|/, }"
} >&2
exit 1
