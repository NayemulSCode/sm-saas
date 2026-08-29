#!/usr/bin/env bash
#
# Deploy. §35.3.
#
# LOW-DOWNTIME, NOT ZERO-DOWNTIME. The app swap below takes a few seconds.
# Genuine zero-downtime needs a second host and shared session state, which
# exists at stage 2 and is not worth its cost before then — the availability
# target is 99.5% in school hours, and this is the honest way to hit it.
#
#   ./scripts/deploy.sh ghcr.io/you/sm-saas@sha256:abc...
#
# Takes a DIGEST, not a tag. A tag can be moved after it is tested; a digest
# cannot, so what was verified on staging is byte-identical to what runs here.

set -euo pipefail

IMAGE="${1:-}"
APP_DIR="${APP_DIR:-/opt/sm-saas}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ -n "$IMAGE" ]] || fail "usage: $0 <image@sha256:digest>"
[[ "$IMAGE" == *"@sha256:"* ]] || fail "pass a digest, not a tag: $IMAGE"

cd "$APP_DIR"

# Deploys happen OUTSIDE 07:00–15:00 Asia/Dhaka. School hours are when
# attendance and fee collection happen: a five-second blip then is a support
# call, and at 19:00 it is nothing.
HOUR=$(TZ=Asia/Dhaka date +%-H)
if (( HOUR >= 7 && HOUR < 15 )) && [[ "${FORCE:-}" != "1" ]]; then
  fail "It is ${HOUR}:00 in Dhaka — school hours. Re-run with FORCE=1 if this is an incident."
fi

export IMAGE

say "Pulling ${IMAGE}"
docker compose pull app worker

# Migrations run BEFORE the new code, and every migration must be backwards
# compatible with the release before it (§7.1) — which is what makes rollback
# "deploy the previous tag" rather than "restore a backup".
say "Migrating"
docker compose run --rm --no-deps app \
  node --experimental-strip-types scripts/migrate.ts \
  || fail "Migration failed. Nothing has been swapped; the old release is still serving."

say "Seeding reference data"
docker compose run --rm --no-deps app \
  node --experimental-strip-types scripts/seed-platform.ts

say "Starting the new app"
docker compose up -d --no-deps --wait app \
  || fail "The new app never became ready. The old one is still serving."

say "Restarting worker"
docker compose up -d --no-deps worker

say "Verifying"
for i in $(seq 1 10); do
  if docker compose exec -T app node -e \
      "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    say "Ready"
    break
  fi
  (( i == 10 )) && fail "Never became ready. Roll back: ./scripts/deploy.sh <previous-digest>"
  sleep 3
done

docker image prune -f --filter 'until=168h' >/dev/null || true

cat <<EOF

Deployed ${IMAGE}

Now verify by hand — §35.3 step 5 says a REAL login, because a green health
check only proves the process can reach the database:
  1. Sign in as a real user on a real school subdomain.
  2. Check the error rate for five minutes.

Roll back with:  ./scripts/deploy.sh <previous-digest>
