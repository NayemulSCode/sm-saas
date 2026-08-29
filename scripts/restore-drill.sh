#!/usr/bin/env bash
#
# Restore drill. §36, quarterly, on a REAL restore.
#
# This is the row that makes every other backup target true. An untested backup
# is not a backup, and the single most common way a small team loses data is
# discovering at restore time that the backups were empty for months.
#
# It restores into a THROWAWAY database and verifies the result. It never
# touches the live one — a drill that could damage production is a drill nobody
# runs.
#
#   ./scripts/restore-drill.sh backups/base-2027-03-14.dump
#
# Exits non-zero if the restore is not usable, so it can be run by cron and the
# failure noticed.

set -euo pipefail

DUMP="${1:-}"
DRILL_DB="${DRILL_DB:-sm_saas_drill_$(date +%s)}"
ADMIN_URL="${DATABASE_URL_MIGRATOR:-}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$DUMP" ]] || fail "usage: $0 <dump-file>"
[[ -f "$DUMP" ]] || fail "no such dump: $DUMP"
[[ -n "$ADMIN_URL" ]] || fail "set DATABASE_URL_MIGRATOR"

# Everything below runs against the server in DATABASE_URL_MIGRATOR but a
# different database name, so a mistake here cannot reach production data.
SERVER_URL="${ADMIN_URL%/*}"
DRILL_URL="${SERVER_URL}/${DRILL_DB}"

cleanup() {
  say "Dropping ${DRILL_DB}"
  psql "$ADMIN_URL" -q -c "DROP DATABASE IF EXISTS \"${DRILL_DB}\" WITH (FORCE)" || true
}
trap cleanup EXIT

started=$(date +%s)

say "Creating ${DRILL_DB}"
psql "$ADMIN_URL" -q -c "CREATE DATABASE \"${DRILL_DB}\""

say "Restoring ${DUMP}"
# --no-owner: the drill database has different role grants and ownership errors
# would mask a real failure in the data.
pg_restore --dbname "$DRILL_URL" --no-owner --no-privileges --jobs 2 "$DUMP" \
  || fail "pg_restore failed"

# ── verification ─────────────────────────────────────────────────────────────
#
# Restoring without erroring is not the same as restoring something usable.
# Each check below is a way a restore has silently produced an empty shell.

say "Verifying"

check() {
  local label="$1" sql="$2" expect="$3"
  local got
  got=$(psql "$DRILL_URL" -tAc "$sql")
  if [[ "$got" != "$expect" ]]; then
    fail "${label}: expected ${expect}, got ${got}"
  fi
  printf '  ok  %-42s %s\n' "$label" "$got"
}

at_least() {
  local label="$1" sql="$2" min="$3"
  local got
  got=$(psql "$DRILL_URL" -tAc "$sql")
  if (( got < min )); then
    fail "${label}: expected at least ${min}, got ${got}"
  fi
  printf '  ok  %-42s %s\n' "$label" "$got"
}

# The schema arrived at all.
at_least "migrations applied" \
  "SELECT count(*) FROM schema_migration" 13

# Reference data survived. A restore that loses the permission vocabulary
# produces a system where every authorised endpoint answers 403.
at_least "permissions seeded" "SELECT count(*) FROM permission" 55
at_least "role templates seeded" "SELECT count(*) FROM role_template" 10

# RLS is a property of the SCHEMA, and pg_restore can drop policies silently if
# the dump was taken without them. A restore that loses RLS is a restore that
# has silently merged every school's data into one visible pool.
check "tenant tables without RLS" "
  SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                     AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)" "0"

check "tenant tables without a policy" "
  SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
                     AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid)" "0"

# The audit trail is append-only in the schema, not only in the application.
check "audit_log is append-only for sm_app" "
  SELECT count(*) FROM information_schema.role_table_grants
  WHERE grantee = 'sm_app' AND table_name IN ('audit_log','auth_event')
    AND privilege_type IN ('UPDATE','DELETE')" "0"

# Actual rows, not just tables. A dump taken with --schema-only restores
# perfectly and contains nobody's data.
at_least "tenants present" "SELECT count(*) FROM tenant" 1

elapsed=$(( $(date +%s) - started ))

cat <<EOF

Restore drill PASSED in ${elapsed}s.

RTO target is 4 hours (§36). This measured the RESTORE only — it does not
include noticing the incident, deciding to restore, or repointing the app.
Record this number and the date; the drill is quarterly and the trend is what
tells you whether the target is still real.
EOF
