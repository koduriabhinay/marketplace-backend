#!/bin/sh
# Self-signed TLS certificate for https://localhost (local development and CI only).
# Browsers will warn about it; for a trusted local cert use mkcert instead:
#   mkcert -cert-file deploy/nginx/certs/tls.crt -key-file deploy/nginx/certs/tls.key localhost 127.0.0.1
# In production the certificate comes from Let's Encrypt or your cloud provider (Phase 7).
set -eu
dir="$(dirname "$0")/../deploy/nginx/certs"
mkdir -p "$dir"
if [ -f "$dir/tls.crt" ]; then echo "Certificate already exists in $dir"; exit 0; fi
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -keyout "$dir/tls.key" -out "$dir/tls.crt" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -addext "basicConstraints=critical,CA:TRUE" 2>/dev/null
chmod 644 "$dir/tls.key" # readable by the nginx container user; never do this with a real key
echo "Wrote $dir/tls.crt and tls.key"
