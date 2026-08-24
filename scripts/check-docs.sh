#!/usr/bin/env bash
# Documentation integrity check.
#
# Phase 1 ships architecture, not code, so this is the only thing CI can
# meaningfully verify today. It catches the two failure modes that actually
# happen: a link to a document that was renamed, and an ADR that exists on disk
# but was never added to the index (or vice versa).
#
# No dependencies beyond coreutils and grep — it must run on a bare runner and
# on a developer's Git Bash without an install step.

set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
note() { printf '  %s\n' "$1"; }

# ---------------------------------------------------------------- broken links
echo "Checking internal Markdown links..."
while IFS= read -r file; do
  dir=$(dirname "$file")
  # Pull the target out of every ](...) link, dropping any #anchor suffix.
  grep -o ']([^)]*)' "$file" 2>/dev/null | sed 's/^](//; s/)$//' | while IFS= read -r target; do
    case "$target" in
      http://*|https://*|mailto:*|'#'*|'') continue ;;
    esac
    path="${target%%#*}"
    [ -z "$path" ] && continue
    if [ ! -e "$dir/$path" ]; then
      printf 'BROKEN %s -> %s\n' "$file" "$target"
    fi
  done
done < <(find . -name '*.md' -not -path './node_modules/*' -not -path './.git/*') > /tmp/link-errors.txt

if [ -s /tmp/link-errors.txt ]; then
  echo "FAIL: broken internal links"
  sed 's/^/  /' /tmp/link-errors.txt
  fail=1
else
  note "ok"
fi

# ------------------------------------------------------------- ADR index drift
echo "Checking the ADR index..."
adr_dir="docs/architecture/adr"
if [ -d "$adr_dir" ]; then
  for adr in "$adr_dir"/[0-9][0-9][0-9][0-9]-*.md; do
    [ -e "$adr" ] || continue
    base=$(basename "$adr")
    if ! grep -q "$base" "$adr_dir/README.md"; then
      note "MISSING FROM INDEX: $base"
      fail=1
    fi
    # Every ADR must declare a status and a revisit trigger. An ADR without
    # "Revisit when" is a decision nobody will ever reconsider on purpose.
    grep -q '^\*\*Status:\*\*' "$adr" || { note "NO STATUS: $base"; fail=1; }
    grep -q 'Revisit when' "$adr"     || { note "NO REVISIT TRIGGER: $base"; fail=1; }
  done
  [ "$fail" -eq 0 ] && note "ok"
fi

# ------------------------------------------------------------ leaked env files
echo "Checking for committed secrets..."
if git ls-files | grep -Ev '^\.env\.example$' | grep -Eq '(^|/)\.env|\.pem$|\.key$|\.dump$'; then
  echo "FAIL: a secret-shaped file is tracked by Git:"
  git ls-files | grep -Ev '^\.env\.example$' | grep -E '(^|/)\.env|\.pem$|\.key$|\.dump$' | sed 's/^/  /'
  fail=1
else
  note "ok"
fi

exit "$fail"
