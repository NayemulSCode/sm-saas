#!/usr/bin/env bash
# Documentation integrity check.
#
# Phase 1 ships architecture, not code, so this is the only thing CI can
# meaningfully verify today. It catches the failure modes that actually happen:
# a link to a document that was renamed, an ADR that exists on disk but was
# never added to the index, and a secret-shaped file reaching the repository.
#
# No dependencies beyond coreutils and grep — it must run on a bare CI runner
# and on a developer's Git Bash without an install step.

set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
errors=$(mktemp)
trap 'rm -f "$errors"' EXIT

note() { printf '  %s\n' "$1"; }

# ---------------------------------------------------------------- broken links
echo "Checking internal Markdown links..."
while IFS= read -r file; do
  dir=$(dirname "$file")
  # Every ](...) target, minus any #anchor. grep exits 1 on no match, which is
  # normal for a file without links — hence the || true.
  targets=$(grep -o ']([^)]*)' "$file" 2>/dev/null | sed 's/^](//; s/)$//' || true)
  [ -z "$targets" ] && continue
  while IFS= read -r target; do
    case "$target" in
      http://*|https://*|mailto:*|'#'*|'') continue ;;
    esac
    path="${target%%#*}"
    [ -z "$path" ] && continue
    if [ ! -e "$dir/$path" ]; then
      printf '%s -> %s\n' "$file" "$target" >> "$errors"
    fi
  done <<< "$targets"
done <<< "$(find . -name '*.md' -not -path './node_modules/*' -not -path './.git/*')"

if [ -s "$errors" ]; then
  echo "FAIL: broken internal links"
  sed 's/^/  /' "$errors"
  fail=1
else
  note "ok"
fi

# ------------------------------------------------------------- ADR index drift
echo "Checking the ADR index..."
adr_dir="docs/architecture/adr"
adr_fail=0
if [ -d "$adr_dir" ]; then
  for adr in "$adr_dir"/[0-9][0-9][0-9][0-9]-*.md; do
    [ -e "$adr" ] || continue
    base=$(basename "$adr")
    grep -q "$base" "$adr_dir/README.md" || { note "MISSING FROM INDEX: $base"; adr_fail=1; }
    # An ADR without "Revisit when" is a decision nobody will reconsider on
    # purpose, which is the one thing the ADR format exists to prevent.
    grep -q '^\*\*Status:\*\*' "$adr" || { note "NO STATUS: $base"; adr_fail=1; }
    grep -q 'Revisit when'     "$adr" || { note "NO REVISIT TRIGGER: $base"; adr_fail=1; }
  done
  [ "$adr_fail" -eq 0 ] && note "ok"
  [ "$adr_fail" -eq 1 ] && fail=1
fi

# ------------------------------------------------------------ leaked env files
echo "Checking for committed secrets..."
leaked=$(git ls-files | grep -Ev '^\.env\.example$' \
                      | grep -E '(^|/)\.env|\.pem$|\.key$|\.dump$' || true)
if [ -n "$leaked" ]; then
  echo "FAIL: a secret-shaped file is tracked by Git:"
  printf '%s\n' "$leaked" | sed 's/^/  /'
  fail=1
else
  note "ok"
fi

exit "$fail"
