#!/usr/bin/env bash
# Runs ON THE SERVER. Gets a certificate from Let's Encrypt the first time, renews it
# when it's within 30 days of expiring, and hands it to Nginx. Safe to run any time;
# cron runs it weekly (see scripts/server-setup.sh).
#
# How the proof works: Let's Encrypt asks for a random file at
# http://<domain>/.well-known/acme-challenge/…; certbot writes it into a folder that
# Nginx serves. Only whoever controls the domain's server can do that.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
. ./.env.prod
set +a
dc() { docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml "$@"; }

if dc run --rm -T --entrypoint sh certbot -c "test -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem"; then
  dc run --rm -T certbot renew --webroot -w /var/www/certbot --quiet
else
  dc run --rm -T certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email --non-interactive
fi

# Copy the current certificate to where Nginx reads it, and reload only if it changed.
changed=$(dc run --rm -T --entrypoint sh certbot -c "
  live=/etc/letsencrypt/live/$DOMAIN
  if ! cmp -s \$live/fullchain.pem /out/tls.crt; then
    cp -L \$live/fullchain.pem /out/tls.crt && cp -L \$live/privkey.pem /out/tls.key && chmod 600 /out/tls.key && echo yes
  fi")
if [ "$changed" = "yes" ]; then
  dc exec -T nginx nginx -s reload
  echo "Certificate for $DOMAIN installed."
else
  echo "Certificate for $DOMAIN is current."
fi
