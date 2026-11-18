#!/usr/bin/env bash
# Runs on YOUR MAC (and in CI). Copies the files the server needs and deploys a tag:
#
#   ./scripts/deploy-remote.sh deploy@203.0.113.10 latest
#
# First deploy only, also say who the site is:
#
#   DOMAIN=myshop.duckdns.org LETSENCRYPT_EMAIL=you@example.com \
#   IMAGE_REPO=ghcr.io/<your-github-name>/marketplace-backend \
#     ./scripts/deploy-remote.sh deploy@203.0.113.10 latest
#
# If the images are private, set REGISTRY_USER and REGISTRY_TOKEN (a token that may read
# packages); the token is sent over SSH's encrypted input, never on a command line.
#
# The server never gets the source code or a build tool: only the Compose files, the
# config in deploy/ and these scripts. The app itself arrives as an image.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:?Usage: deploy-remote.sh <user@host> <image-tag>}"
TAG="${2:?Usage: deploy-remote.sh <user@host> <image-tag>}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-})

# COPYFILE_DISABLE stops macOS tar from adding ._ metadata files.
COPYFILE_DISABLE=1 tar -czf - --exclude='deploy/nginx/certs' --exclude='scripts/seed-assets' \
  docker-compose.yml docker-compose.prod.yml deploy scripts |
  "${SSH[@]}" "$TARGET" 'mkdir -p ~/marketplace && tar -xzf - -C ~/marketplace'

q() { printf '%q' "$1"; }
remote="cd ~/marketplace && DOMAIN=$(q "${DOMAIN:-}") LETSENCRYPT_EMAIL=$(q "${LETSENCRYPT_EMAIL:-}") IMAGE_REPO=$(q "${IMAGE_REPO:-}")"
if [ -n "${REGISTRY_TOKEN:-}" ]; then
  printf '%s' "$REGISTRY_TOKEN" |
    "${SSH[@]}" "$TARGET" "$remote REGISTRY_USER=$(q "${REGISTRY_USER:?Set REGISTRY_USER}") ./scripts/deploy.sh $(q "$TAG") --registry-token-stdin"
else
  "${SSH[@]}" "$TARGET" "$remote ./scripts/deploy.sh $(q "$TAG")"
fi
