# Phase 7: On the internet — what you built and why

Phases 1 to 6 built the marketplace and ran it on your laptop. Phase 7 puts the same stack
on a rented server with a real name and a real certificate, and makes every merge to
`main` go live by itself.

## The shape

```
 you: git push ─► GitHub Actions: test ─► build images ─► ghcr.io ─► deploy job
                                                                        │ SSH (key only)
                                                                        ▼
 internet ─► DNS name ─► server :80/:443 ─► nginx ─► api × 3 ─► postgres + replica, redis
              (firewall: 22, 80, 443 only)      │
                                                └─ certbot ◄─► Let's Encrypt (certificate, renewed by cron)

 on the server, in ~/marketplace:
   docker-compose.yml + docker-compose.prod.yml   same stack, production overrides
   .env.prod, secrets/                            passwords and keys, created on the first deploy
   backups/                                       nightly database + photo backups, 14 days
```

The server never has the source code or a compiler. It gets two Compose files, the
config in `deploy/`, a few scripts, and images that CI already tested.

## Production criteria covered in this phase

| Concept | Where | What to say in an interview |
| --- | --- | --- |
| Build once, deploy the same artifact | CI `publish` → `deploy`, `scripts/deploy.sh` | The image that passed the tests is the image that runs: tagged with the commit SHA, pulled by the server, never rebuilt. "Works in CI but not in prod" can't come from a different build. |
| Continuous deployment | CI `deploy` job | A merge to `main` deploys itself after tests and publishing pass. One deploy at a time (`concurrency`), and the job is skipped until the server is configured. |
| Config separate from code | `docker-compose.prod.yml`, `.env.prod` | One Compose file for every environment plus a small production override. Passwords live only on the server (`.env.prod`, mode 600) and are generated there; nothing secret is in Git or in an image. |
| Smallest possible attack surface | `docker-compose.prod.yml`, `scripts/server-setup.sh` | Only Nginx is reachable (80, 443). Postgres, Redis and RabbitMQ publish no ports; Grafana and Prometheus listen on 127.0.0.1 and are reached through an SSH tunnel. Docker bypasses `ufw`, so the Compose file, not just the firewall, has to be right. |
| Server hardening | `scripts/server-setup.sh` | SSH by key only, no root login, a non-root `deploy` user, firewall, automatic security updates, fail2ban, capped Docker logs, swap. |
| Real TLS | `scripts/prod-cert.sh`, Nginx `/.well-known/acme-challenge/` | Let's Encrypt checks we control the domain by fetching a file over HTTP (the ACME HTTP-01 challenge). Certificates last 90 days; a weekly cron job renews and reloads Nginx with no downtime. HSTS starts short and is raised once HTTPS is proven. |
| Health-checked deploys and rollback | `scripts/deploy.sh` | After starting the new version the script polls `/ready` through Nginx. If migrations fail or the site doesn't come up, it starts the previous tag again and exits non-zero, so the CI job goes red. Rehearsed with a deliberately broken image. |
| Migrations in a deploy | `migrate` service | Migrations run once, before any new app container starts. Because a rollback runs old code against the new schema, migrations must be backward compatible: add first, remove in a later release (expand, then contract). |
| Backups you can restore | `scripts/prod-backup.sh` | A database dump and the uploaded photos, nightly and before every deploy, kept 14 days. The restore is written down below and worth rehearsing. A backup on the same disk doesn't survive losing the server, so copy it off the machine too. |
| Secrets that must outlive the server | `secrets/` | The JWT secret can be rotated (everyone logs in again). The encryption key can't be replaced casually: it decrypts stored 2FA and webhook secrets. It's created once and never overwritten; keep a copy in a password manager. |
| Knowing the limits | this document | One server is a single point of failure, and a deploy restarts the API containers together (a few seconds where Nginx answers 502). "What it would take next" below is the honest list. |

## Step by step

You need: a server (Step 1), a name for it (Step 2), and about 30 minutes.

### 1. Create the server

Any provider works. You want **Ubuntu 24.04, 4 GB of memory or more, 30 GB of disk**, and
you log in with an **SSH key**, never a password.

Make a key on your Mac if you don't have one:

```bash
ssh-keygen -t ed25519 -C "marketplace"      # press Enter for the default file; set a passphrase
cat ~/.ssh/id_ed25519.pub                    # this public half is what you give the provider
```

On AWS (EC2 → Launch instance):

- **Image:** Ubuntu Server 24.04 LTS. **Type:** the smallest one with at least 4 GB that
  your plan allows.
- **Key pair:** import the public key above (EC2 → Key pairs → Actions → Import).
- **Network (security group):** allow SSH (22) from **My IP** only, and HTTP (80) and
  HTTPS (443) from anywhere.
- **Storage:** 30 GB gp3.
- After it starts: **Elastic IPs → Allocate → Associate** with the instance, so the
  address survives a restart. Note that IP address.

### 2. Give it a name

A certificate is issued for a name, not an IP address. Either:

- **Free:** create a subdomain at https://www.duckdns.org (sign in, pick a name, paste the
  server's IP). You get `yourname.duckdns.org`.
- **Your own domain** (about $10 to $15 a year): add an `A` record pointing at the IP.

Check it from your Mac: `dig +short yourname.duckdns.org` should print the server's IP.

### 3. Prepare the server (once)

```bash
# AWS's first user is "ubuntu"; on providers that give you root, use root@ and drop "sudo".
ssh ubuntu@SERVER_IP 'sudo bash -s' < scripts/server-setup.sh
ssh deploy@SERVER_IP 'docker --version'      # from now on you are "deploy"
```

### 4. Let the server pull the images

CI publishes two images to GitHub's registry. The simplest setup is to make them public
(they contain only what's already in the public repo): GitHub → your profile → Packages →
`marketplace-backend` → Package settings → Change visibility → Public. Do the same for
`marketplace-backend-web`. (Private works too: see `REGISTRY_TOKEN` in
`scripts/deploy-remote.sh`. The CI deploy job always logs in by itself.)

### 5. First deploy, from your Mac

```bash
DOMAIN=yourname.duckdns.org \
LETSENCRYPT_EMAIL=you@example.com \
IMAGE_REPO=ghcr.io/YOUR_GITHUB_NAME/marketplace-backend \
  ./scripts/deploy-remote.sh deploy@SERVER_IP latest
```

It prints `Deployed latest: https://yourname.duckdns.org`. Open it: a padlock, no warning.
Add demo products if you like: `SEED_BASE_URL=https://yourname.duckdns.org node scripts/seed-demo.mjs`.

**Right now, copy the encryption key somewhere safe** (a password manager):

```bash
ssh deploy@SERVER_IP 'cat ~/marketplace/secrets/encryption_key'
```

### 6. Turn on automatic deploys

Make a separate key that only CI uses, and let it log in as `deploy`:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/marketplace_ci -C "github-actions"
ssh deploy@SERVER_IP 'cat >> ~/.ssh/authorized_keys' < ~/.ssh/marketplace_ci.pub
ssh-keyscan -t ed25519 SERVER_IP             # the server's identity, for DEPLOY_KNOWN_HOSTS
```

In GitHub → the repository → Settings → Secrets and variables → Actions:

| Kind | Name | Value |
| --- | --- | --- |
| Secret | `DEPLOY_SSH_KEY` | the contents of `~/.ssh/marketplace_ci` (the private half) |
| Secret | `DEPLOY_KNOWN_HOSTS` | the line printed by `ssh-keyscan` |
| Variable | `DEPLOY_HOST` | the server's IP |
| Variable | `DEPLOY_DOMAIN` | `yourname.duckdns.org` |

On AWS, GitHub's runners must be able to reach port 22, so change the SSH rule in the
security group from "My IP" to "Anywhere". That is acceptable here because the server
accepts keys only and fail2ban blocks repeated failures.

The next merge to `main` runs `check → web → e2e → publish → deploy`.

### 7. Once it has worked for a day

On the server, edit `~/marketplace/.env.prod` and set `HSTS_MAX_AGE=63072000`, then deploy
again. Browsers will refuse plain HTTP for this name for two years, so only do it when
HTTPS is solid.

## Day-to-day

```bash
ssh deploy@SERVER_IP
cd ~/marketplace
alias dc='docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml'

dc ps                                  # what's running
dc logs -f --tail=50 api               # live logs (JSON, with request IDs)
cat .deployed_tag                      # which version is live
./scripts/deploy.sh sha-<older-sha>    # roll back by hand: deploy an older tag
./scripts/prod-backup.sh               # back up now
tail cron.log                          # nightly backup and certificate checks

# Dashboards, from your Mac (they are not on the internet):
ssh -L 3030:127.0.0.1:3030 deploy@SERVER_IP    # then open http://localhost:3030
ssh deploy@SERVER_IP 'grep GRAFANA ~/marketplace/.env.prod'   # the admin password
```

Copy the backups off the server now and then (or from a cron job on another machine):

```bash
rsync -av deploy@SERVER_IP:marketplace/backups/ ~/marketplace-backups/
```

Restore a backup (rehearse this once, so the first time isn't during an emergency):

```bash
dc stop api worker
dc exec -T postgres pg_restore -U marketplace -d marketplace --clean --if-exists \
  --no-owner --no-privileges --single-transaction < backups/marketplace-<stamp>.dump
dc start api worker
# photos: docker cp backups/uploads-<stamp>.tar.gz "$(dc ps -q api | head -n 1)":/tmp/u.tgz
#         docker exec "$(dc ps -q api | head -n 1)" tar -xzf /tmp/u.tgz -C /app
```

Stop paying: delete the server (on AWS also release the Elastic IP). Everything on it is
gone, so pull the backups first if you want them.

## What it would take next

This is a real, secured deployment of a learning project. A marketplace with paying
customers would add:

- **No single server.** Two or more app servers in different zones behind a managed load
  balancer; a managed database (RDS) with automatic failover and point-in-time recovery;
  managed Redis and a managed queue.
- **Zero-downtime deploys.** Start new containers, wait for health, shift traffic, stop
  the old ones (rolling or blue-green), which an orchestrator (ECS, Kubernetes) does for
  you. Today a deploy means a few seconds of 502s.
- **Photos in object storage** (S3) with a CDN in front, instead of a disk on one server.
- **Off-site, tested backups** on a schedule, with alerts when one fails.
- **Alerts that reach a person** (Alertmanager to email or a pager), uptime checks from
  outside, and centralised logs.
- **Secrets in a secrets manager** with rotation, and infrastructure described in code
  (Terraform) so the server can be rebuilt from scratch.

## Practice questions

1. Why deploy an image tagged with the commit SHA instead of `latest`?
2. The server has no source code. What does it have, and why is that safer?
3. `ufw` denies port 5432, yet a container with `ports: ["5432:5432"]` is reachable from
   the internet. Why, and how does this project avoid it?
4. How does Let's Encrypt know you control the domain? What must be reachable for renewal
   to keep working?
5. A deploy's migration succeeds but the new code crashes. The script rolls back the
   code. What must be true of the migration for the old code to keep working?
6. Why is losing the encryption key worse than losing the JWT secret?
7. What does HSTS do, and why start with a small `max-age`?
8. The backup job runs every night. What else has to be true before you can call the
   data safe?
9. Name two single points of failure in this deployment and what removes each.
10. Why does CI pin the server's host key instead of accepting whatever key it sees?
