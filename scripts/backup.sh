#!/usr/bin/env bash
#
# Nightly logical backup. §36.1.
#
# This is the BASE backup. Continuous WAL archiving is what takes the RPO from
# "last night" to 60 seconds, and it is configured in PostgreSQL rather than
# here — see docker-compose.yml and docs/DEPLOYMENT.md.
#
# Backups go to a DIFFERENT PROVIDER than the compute: Hetzner or DO for the
# host, Cloudflare R2 for the backups. A provider-level account problem should
# not take the host and its backups at the same time.
#
#   ./scripts/backup.sh            # writes to ./backups
#   RETAIN_DAYS=30 ./scripts/backup.sh

set -euo pipefail

OUT_DIR="${OUT_DIR:-./backups}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
ADMIN_URL="${DATABASE_URL_MIGRATOR:?set DATABASE_URL_MIGRATOR}"

mkdir -p "$OUT_DIR"
STAMP=$(date -u +%Y-%m-%dT%H%M%SZ)
OUT="${OUT_DIR}/base-${STAMP}.dump"

echo "==> pg_dump → ${OUT}"

# Custom format: parallel restore, selective restore, and compressed. A plain
# SQL dump of a school's data is large and can only be restored serially.
pg_dump --format=custom --compress=9 --file="$OUT" "$ADMIN_URL"

# Verify the dump can be READ before trusting it. pg_restore --list fails on a
# truncated file, which is how a backup interrupted by a full disk gets caught
# tonight rather than at restore time.
if ! pg_restore --list "$OUT" > /dev/null; then
  echo "FAILED: ${OUT} is not readable by pg_restore — removing" >&2
  rm -f "$OUT"
  exit 1
fi

SIZE=$(du -h "$OUT" | cut -f1)
echo "==> ok, ${SIZE}"

# A dump that is suspiciously small usually means an empty database, which is
# worse than no backup because it looks like one.
BYTES=$(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT")
if (( BYTES < 4096 )); then
  echo "FAILED: ${OUT} is only ${BYTES} bytes — is the database empty?" >&2
  exit 1
fi

echo "==> Pruning local dumps older than ${RETAIN_DAYS} days"
find "$OUT_DIR" -name 'base-*.dump' -type f -mtime "+${RETAIN_DAYS}" -print -delete

cat <<EOF

Written: ${OUT}

NOT DONE HERE: the upload to R2. It needs the bucket and credentials from
docs/EXTERNAL-ACTIONS.md, and a backup that only exists on the host it is
backing up is not a backup. Once R2 exists:

  restic -r s3:https://<account>.r2.cloudflarestorage.com/<bucket> backup ${OUT_DIR}
EOF
