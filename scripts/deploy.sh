#!/usr/bin/env bash
# Runs ON THE SERVER, in ~/marketplace. Deploys one image tag:
#
#   ./scripts/deploy.sh <tag>            e.g. sha-3f9c1a… or latest
#
# You normally don't call it directly: scripts/deploy-remote.sh (from your Mac) and the
# CI deploy job copy the files here and run it.
#
# What it does, in order:
#   1. first run only: creates .env.prod with random passwords and the app's secrets;
#   2. backs up the database (so a bad migration can be undone);
#   3. pulls the images and starts them (migrations run first, as on your laptop);
#   4. waits until the site answers; if it doesn't, goes back to the previous tag;
#   5. gets a Let's Encrypt certificate the first time.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="${1:?Usage: deploy.sh <image-tag>}"
ENV_FILE=.env.prod
rand() { openssl rand -hex 24; }

# --- 1. First run: settings and secrets ---------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  : "${DOMAIN:?First deploy: set DOMAIN, the public name of the site}"
  : "${LETSENCRYPT_EMAIL:?First deploy: set LETSENCRYPT_EMAIL}"
  : "${IMAGE_REPO:?First deploy: set IMAGE_REPO, for example ghcr.io/you/marketplace-backend}"
  umask 077
  cat > "$ENV_FILE" <<EOF
DOMAIN=$DOMAIN
LETSENCRYPT_EMAIL=$LETSENCRYPT_EMAIL
IMAGE_REPO=$IMAGE_REPO
POSTGRES_PASSWORD=$(rand)
REPLICATION_PASSWORD=$(rand)
RABBITMQ_USER=marketplace
RABBITMQ_PASSWORD=$(rand)
GRAFANA_ADMIN_PASSWORD=$(rand)
HTTP_PORT=80
HTTPS_PORT=443
HSTS_MAX_AGE=3600
EOF
  echo "Created $ENV_FILE with new random passwords."
fi
set -a
# shellcheck disable=SC1090
. "./$ENV_FILE"
set +a

# The JWT signing secret and the encryption key. Created once and never replaced:
# losing the encryption key makes every stored 2FA and webhook secret unreadable.
mkdir -p secrets
for name in jwt_secret encryption_key; do
  if [ ! -s "secrets/$name" ]; then
    (umask 077 && openssl rand -hex 32 > "secrets/$name")
    chmod 644 "secrets/$name" # the app runs as a non-root user inside its container
    echo "Created secrets/$name. Keep a copy somewhere safe."
  fi
done

# Nginx can't start without a certificate file, so begin with a self-signed one; the
# real one replaces it in step 5.
./scripts/dev-cert.sh > /dev/null

export APP_IMAGE="$IMAGE_REPO:$TAG"
export WEB_IMAGE="$IMAGE_REPO-web:$TAG"
dc() { docker compose --env-file "$ENV_FILE" -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

# Private images: log in to the registry with a token read from standard input.
if [ "${2:-}" = "--registry-token-stdin" ]; then
  docker login "${IMAGE_REPO%%/*}" -u "${REGISTRY_USER:?Set REGISTRY_USER}" --password-stdin
  # Don't leave the (short-lived) token on the server once this script ends.
  trap 'docker logout "${IMAGE_REPO%%/*}" > /dev/null' EXIT
fi

# --- 2. Backup before changing anything -----------------------------------------------
if [ -n "$(dc ps -q postgres 2>/dev/null)" ]; then
  ./scripts/prod-backup.sh || { echo "Backup failed: not deploying."; exit 1; }
fi

# --- 3. Pull and start ----------------------------------------------------------------
PREVIOUS="$(cat .deployed_tag 2>/dev/null || true)"
dc pull --quiet migrate nginx
started=yes
dc up -d --no-build --remove-orphans || started=no # e.g. a migration failed

# --- 4. Health check, and roll back if it fails ----------------------------------------
healthy() {
  for _ in $(seq 1 30); do
    if curl -fsSk --max-time 3 https://127.0.0.1:"$HTTPS_PORT"/ready > /dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
if [ "$started" = no ] || ! healthy; then
  echo "The new version did not start or did not become healthy."
  dc ps
  dc logs --tail=40 migrate api || true
  if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$TAG" ]; then
    echo "Rolling back to $PREVIOUS (the database backup from step 2 is in backups/)."
    export APP_IMAGE="$IMAGE_REPO:$PREVIOUS" WEB_IMAGE="$IMAGE_REPO-web:$PREVIOUS"
    dc up -d --no-build --remove-orphans
    healthy && echo "Rolled back." || echo "Rollback is not healthy either: look at the logs above."
  fi
  exit 1
fi
echo "$TAG" > .deployed_tag

# --- 5. Certificate --------------------------------------------------------------------
./scripts/prod-cert.sh

docker image prune -f > /dev/null
echo "Deployed $TAG: https://$DOMAIN"
