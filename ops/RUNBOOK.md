# Plotinium operations runbook

How the team builds, deploys, backs up, restores, watches and repairs the production host. Every step here implements [specs/14-devops/deployment-and-ci.md](../specs/14-devops/deployment-and-ci.md) (OPS-01 to OPS-22) and the secrets rules of [specs/12-security/security-model.md §3.11](../specs/12-security/security-model.md). If this runbook and a spec disagree, the spec wins and this file is corrected.

- **Primary owner:** R5 QA/DevOps & Integration. **Reviewer:** R1 Kernel (R2 for the database steps).
- **Placeholders:** `<org>` is the GitHub organisation, `<domain>` the production domain and `<host>` the VPS address. None of them is a secret.
- **Never** paste a password, token or private key into this file, an issue, a PR, a chat log or a screenshot (spec §18). Secrets live only in the places listed in §3.

| #   | Procedure                                                           | When                                      |
| --- | ------------------------------------------------------------------- | ----------------------------------------- |
| 1   | [First-time VPS setup](#1-first-time-vps-setup)                     | Week 1–2, and for every rebuild           |
| 2   | [Domain and DNS](#2-domain-and-dns)                                 | Week 1–2                                  |
| 3   | [Secrets](#3-secrets)                                               | before the first deploy; on rotation      |
| 4   | [GitHub settings](#4-github-settings)                               | once, before the first tag                |
| 5   | [Release and deploy](#5-release-and-deploy)                         | every gate tag                            |
| 6   | [Rollback](#6-rollback)                                             | a bad release                             |
| 7   | [Backups to Cloudflare R2](#7-backups-to-cloudflare-r2-with-rclone) | nightly (automatic), before every deploy  |
| 8   | [Restore and the restore drill](#8-restore-and-the-restore-drill)   | weekly drill; before every gate; disaster |
| 9   | [Monitoring with UptimeRobot](#9-monitoring-with-uptimerobot)       | once; alerts at any time                  |
| 10  | [Leaked-key procedure](#10-leaked-key-procedure)                    | as soon as a leak is suspected            |
| 11  | [Gate-week checklist](#11-gate-week-checklist)                      | T-7 and T-1 days before a gate            |

---

## 1. First-time VPS setup

**Target (OPS-12, OPS-13).** Ubuntu 24.04 LTS on a Hetzner CX33 (4 vCPU, 8 GB, 80 GB) in Falkenstein (`fsn1`) or Nuremberg (`nbg1`). If no CX33 can be ordered within 72 hours, use an OVHcloud VPS-2, then Contabo or DigitalOcean. Ceiling €15 per month. The host is described by one file, [`ops/cloud-init.yaml`](cloud-init.yaml); [`ops/provision.sh`](provision.sh) renders it, orders the server and checks the result.

### 1.1 Prerequisites (on a member's laptop)

- The `hcloud` CLI, and a Hetzner API token exported in your shell only: `export HCLOUD_TOKEN=…`. Never commit it and never store it in GitHub (spec §3.9); revoke it after provisioning.
- A file `team.pub` with the **public** keys of every member plus the CI deploy key (§3.2), one per line. `provision.sh` refuses a file that contains a private key.

### 1.2 Order the server (Hetzner)

```sh
ops/provision.sh create --keys team.pub --name plotinium-prod --type cx33 --location fsn1
```

This command:

1. renders `ops/cloud-init.yaml` with your keys and the hostname, and validates it against the cloud-init schema;
2. creates or updates the Hetzner Cloud Firewall `plotinium` (inbound 22/tcp, 80/tcp, 443/tcp, 443/udp and ICMP; everything else is dropped);
3. retries `hcloud server create` every 10 s for up to an hour while the CX line is out of stock (§3.13 "buy early, never recreate");
4. prints the IPv4 and IPv6 addresses for DNS (§2).

Use `--dry-run` to print the rendered user data without ordering anything. Running servers keep the price they were bought at, so **never delete and recreate** the production server to fix something; rebuild it in place instead (§1.6).

### 1.3 Other providers (OVHcloud fallback)

Order Ubuntu 24.04, log in once with the provider's credentials, then apply the same configuration:

```sh
git clone https://github.com/<org>/plotinium.git /tmp/plotinium   # or scp the ops/ folder
sudo /tmp/plotinium/ops/provision.sh host --keys team.pub --hostname plotinium-prod
```

`host` applies `ops/cloud-init.yaml` itself: packages, every `write_files` entry, the swap file and every `runcmd` step, in order. It refuses to harden sshd while the `deploy` user has no authorized key, so you cannot lock yourself out. At OVH there is no external firewall API in this script: create the equivalent rules (22/tcp, 80/tcp, 443/tcp, 443/udp, ICMP) in the OVH network firewall by hand. UFW on the host is only defence in depth, because Docker-published ports bypass UFW.

### 1.4 After first boot (as `deploy`)

Cloud-init leaves a motd pointing here. From your laptop:

```sh
ssh deploy@<host>
sudo -n true 2>/dev/null && echo "WRONG: deploy must not have sudo"
cloud-init status --wait        # waits for the first boot to finish
```

Then, on the VPS as `deploy`, turn `/srv/plotinium` into a checkout of the repository. `/srv/plotinium/secrets` and `/srv/plotinium/state` already exist, so clone into the non-empty directory like this:

```sh
cd /srv/plotinium
git init -q
git remote add origin https://github.com/<org>/plotinium.git
git fetch --tags --quiet origin
git checkout --detach "$(git tag --list 'v*' --sort=-v:refname | head -1)"
```

A private repository needs a read-only **deploy key** instead: generate a key pair on the VPS (`ssh-keygen -t ed25519 -f ~/.ssh/github_ro -N ''`), add the public half to the repository as a read-only deploy key, and use `git@github.com:<org>/plotinium.git` as the remote with `core.sshCommand "ssh -i ~/.ssh/github_ro"`. Note also that `ops/deploy.sh` downloads `images.lock.json` from the public release URL, which needs a public repository.

### 1.5 Verify the host

```sh
sudo ops/provision.sh verify     # from an admin session on the console, or:
ops/provision.sh verify          # as deploy (root-only checks are reported as SKIP)
```

Every line must be `PASS` (Docker Compose ≥ 2.24.4, live-restore, `local` log driver; `deploy` has uid 1000, the `docker` group and no sudo; sshd key-only with `PermitRootLogin no` and `AllowUsers deploy`; BBR and `fq`; `tcp_slow_start_after_idle = 0`; swap; UFW rules; unattended security upgrades without automatic reboot; directories and modes; both timers). From your laptop, check the cloud firewall from outside:

```sh
nc -vz -w 3 <host> 22 && nc -vz -w 3 <host> 443          # open
nc -vz -w 3 <host> 5432 || echo "5432 closed, as required" # never published (OPS-02)
ssh -o PasswordAuthentication=yes -o PubkeyAuthentication=no deploy@<host>  # must be refused
ssh root@<host>                                                              # must be refused
```

Keep the `verify` output as rebuild-drill evidence in `docs/evidence/deploy/`.

### 1.6 Rebuild drill (before P2 and before the freeze)

Target: a fresh hourly server to `/api/readyz` green within 30 minutes (`OPS-14.rebuild`). Order a second server with `--name plotinium-drill`, then §1.4, §3, `ops/deploy.sh <current tag> --no-backup`, then restore the latest R2 backup (§8.2). Record the duration and delete the drill server.

**About the `docker` group.** Membership of `docker` is equivalent to root on the host. That is accepted: `deploy` is the only login, it has no password, and only the members' keys and the approval-gated CI key can use it.

---

## 2. Domain and DNS

1. Claim a free `.me` or `.tech` domain from the GitHub Student Developer Pack (first year free). Record who owns the registrar account; the instructor must agree that it is acceptable as the production URL (spec §9.1 question 2).
2. At the registrar's DNS (or Cloudflare DNS with the proxy **off**, grey cloud: Caddy must terminate TLS itself and the WebSocket must reach it directly), create:

   | Type | Name | Value                                   | TTL  |
   | ---- | ---- | --------------------------------------- | ---- |
   | A    | `@`  | the VPS IPv4 from `provision.sh create` | 300  |
   | AAAA | `@`  | the VPS IPv6                            | 300  |
   | CAA  | `@`  | `0 issue "letsencrypt.org"`             | 3600 |

3. Wait until `dig +short <domain>` returns the VPS address from two networks (the campus network and a phone).
4. Put the domain in `/srv/plotinium/.env` (§3.1) and in the GitHub environment variable `PLOTINIUM_DOMAIN` (§4). On the first `up`, Caddy obtains the certificate by ACME and keeps it in the `caddy_data` volume, so recreating the container never re-issues it (Let's Encrypt allows 5 duplicate certificates per 7 days).
5. Check: `curl -sI https://<domain>/ | grep -i strict-transport-security` shows HSTS (production only), and `curl -sI http://<domain>/` redirects to HTTPS.

---

## 3. Secrets

The inventory is spec §3.9 and security-model §3.11.1. No secret is ever in the repository, `compose.yaml`, `.env.example`, the README or the client bundle; gitleaks runs on every pull request and over the release shell.

### 3.1 On the VPS (`/srv/plotinium`, owner `deploy`)

| File                             | Mode           | Content                                                                                                                                                                | How it is made                            |
| -------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `.env`                           | 0600           | **non-secret** settings only: `PLOTINIUM_DOMAIN=<domain>`, `LLM_BUDGET_USD_MONTH=50`, `LLM_BUDGET_USD_TOTAL=250`; the day before the defence also `LEASE_TTL_MS=15000` | by hand, see below                        |
| `.env.images`                    | 0644           | the three image references by digest                                                                                                                                   | written by `ops/deploy.sh`; never edit    |
| `secrets/anthropic_api_key`      | 0400, uid 1000 | the production LLM key (a separate key with a provider-side spend limit)                                                                                               | by hand, see below                        |
| `secrets/llm_upstream_accept`    | 0400, uid 1000 | SHA-256 hashes of revocable upstream tokens, one per line; may be empty                                                                                                | created empty by cloud-init               |
| `secrets/rclone.conf`            | 0600           | the R2 read/write credentials (§7)                                                                                                                                     | `rclone config`                           |
| `secrets/auth_pepper` (optional) | 0400, uid 1000 | the Argon2id pepper; a paper copy is kept by R2 and R5                                                                                                                 | `head -c 32 /dev/urandom \| xxd -p -c 64` |

The database passwords are **not** in this table: the `db` image generates them at first start into the `dbsecrets` volume, on every stack including production, so no human handles them (§3.1.1).

```sh
cd /srv/plotinium
umask 077
printf 'PLOTINIUM_DOMAIN=%s\nLLM_BUDGET_USD_MONTH=50\nLLM_BUDGET_USD_TOTAL=250\n' <domain> > .env
# Paste the key without echoing it and without leaving it in the shell history:
( IFS= read -rs k; printf '%s' "$k" > secrets/anthropic_api_key ); chmod 0400 secrets/anthropic_api_key
ls -l secrets/     # every file owned by deploy (uid 1000), none group- or world-readable
```

`deploy` has uid 1000, the uid of the `node` user in the `app` container, so the Compose secrets are readable inside the container without widening their mode. If `provision.sh host` warned that uid 1000 was taken, ask an admin to `chown 1000:1000` the three secret files instead.

The server refuses to start in production with a missing secret, a secret shorter than 32 bytes, a known development value, or `FAULT_INJECTION=1` (SRV-02). `compose.prod.yaml` forces `FAULT_INJECTION=0`.

### 3.2 In GitHub

| Where                                | Name                                                            | Value                                                                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment `production` → secrets   | `VPS_HOST`                                                      | the VPS address                                                                                                                                                                                                                                                             |
|                                      | `VPS_USER`                                                      | `deploy`                                                                                                                                                                                                                                                                    |
|                                      | `VPS_SSH_KEY`                                                   | the private half of a key pair made **only** for CI: `ssh-keygen -t ed25519 -C plotinium-ci-deploy -f ci_deploy -N ''`; put `ci_deploy.pub` in `team.pub` (or append it to `~deploy/.ssh/authorized_keys`), paste `ci_deploy` here, then delete both files from your laptop |
|                                      | `VPS_KNOWN_HOSTS`                                               | the host key line: `ssh-keyscan -t ed25519 <host>`, checked against the fingerprint the Hetzner console shows (`ssh-keygen -lf`). Without it the deploy job trusts on first use and warns                                                                                   |
| Environment `production` → variables | `PLOTINIUM_DOMAIN`                                              | `<domain>`                                                                                                                                                                                                                                                                  |
| Environment `llm-eval` → secrets     | `ANTHROPIC_API_KEY_EVAL`                                        | a separate evaluation key with a provider-side spend cap (release-time live AI evaluation; not used by `release.yml` yet)                                                                                                                                                   |
| Environment `backup-drill` → secrets | `R2_RO_ACCESS_KEY_ID`, `R2_RO_SECRET_ACCESS_KEY`, `R2_ENDPOINT` | a **read-only** R2 token scoped to the bucket (weekly CI restore drill)                                                                                                                                                                                                     |

CI never holds the production LLM key: CI replays recorded model responses (`LLM_MODE=replay`), and a test asserts the key is absent.

### 3.3 Paper

Production root and examiner passwords are printed once by the first start of the `app` container (§5.3), copied **by hand onto paper**, sealed, and handed to the examiners at the gate. They are rotated right after each gate.

### 3.4 Rotation

| Secret             | Rotation                                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| LLM key            | on any suspicion (§10); at the end of the semester                                                                 |
| CI deploy key      | per semester and when a member leaves: new pair, replace `VPS_SSH_KEY`, remove the old line from `authorized_keys` |
| Member keys        | when a member leaves: remove the line from `~deploy/.ssh/authorized_keys` and from `team.pub`                      |
| Database passwords | `ops/rotate-db-passwords.sh` (TODO R5): `ALTER ROLE`, swap the files in `dbsecrets`, restart `app`                 |
| R2 tokens          | per semester                                                                                                       |
| Hetzner API token  | right after provisioning                                                                                           |

---

## 4. GitHub settings

Done once by R5 before the first tag (spec §3.4, §3.8, §3.17):

1. **Packages public.** After the first release run pushes `plotinium-web`, `plotinium-app` and `plotinium-db`, open each package on GHCR → Package settings → Change visibility → **Public**, and link it to the repository. Anonymous pulls are what the bring-up job proves (OPS-04); until then it fails with "unauthorized".
2. **Environment `production`:** required reviewers = the other four members; **Prevent self-review** on; deployment branches and tags limited to `v*` tags and `main`; add the secrets and the variable of §3.2.
3. **Actions → General:** workflow permissions "Read repository contents"; tick **Allow GitHub Actions to create and approve pull requests** (the pin PR, §5.2).
4. **Repository variables** (all optional): `ARM64_RUNNER` (`ubuntu-24.04` on a private repository without arm64 runners, which makes the arm64 half build under QEMU), `WEB_BUILD` (default `required`), `REQUIRE_LAB_PERF` (`true` once `perf-lab.yml` exists), `PLT_SEMESTER_START` (ISO date of week 1, for the budget checker), `BRINGUP_ALLOW_DOCKER_HUB` (leave unset), `DEPLOY_ON_RELEASE` (`false` in a fork).
5. **Tag ruleset on `v*`:** only R5 and one named deputy may create tags; no update, no deletion (§3.8).

---

## 5. Release and deploy

### 5.1 Cut a release (R5, the day before a gate)

1. Feature cut-off 3 days before the gate; `main` is green.
2. A PR sets the root `package.json` `version` to `X.Y.Z` and moves the CHANGELOG entries from `[Unreleased]` to `## [X.Y.Z] - <date>`, grouped by requirement ID. It merges with a second member's approval.
3. Tag the merge commit on `main` and push the tag:

   ```sh
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "Plotinium X.Y.Z (<gate>)"
   git push origin vX.Y.Z
   ```

### 5.2 What `release.yml` does

| Job       | What it proves or produces                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`  | tag matches `vX.Y.Z` or `vX.Y.Z-rc.N`; equals `package.json`; CHANGELOG has the section; the commit is on `main`; the tree is clean after install (PLT-ID-15)                                                                                                                                                       |
| `suite`   | Prettier, ESLint, TypeScript 7, Vitest with coverage and JUnit, the traceability matrix                                                                                                                                                                                                                             |
| `perf`    | hosted micro-benchmarks (smoke) and, when present, the lab-spec result for the same tree from `perf-lab.yml`, checked against `budgets.json`                                                                                                                                                                        |
| `images`  | `web`, `app` and `db` for linux/amd64 and linux/arm64, with SBOM and provenance, pushed by digest                                                                                                                                                                                                                   |
| `publish` | the multi-arch manifest lists tagged `X.Y.Z`, `X.Y` and `sha-<12>` (an existing `X.Y.Z` is never overwritten), `images.lock.json`, the SBOMs; the release shell contains no test-flag handler and no secret                                                                                                         |
| `bringup` | on a fresh runner with **no `docker login` and Docker Hub blocked**: `git clone`, `cd plotinium`, `docker compose up -d --wait` with this release's digests, then `/` and `/api/readyz` answer, all within **240 s** (spec limit 300 s); amd64 and, where a native runner exists, arm64                             |
| `release` | the GitHub Release: CHANGELOG notes plus generated notes; assets `coverage-summary.json`, the HTML coverage report, `coverage-lcov.info`, JUnit XML, `traceability.json`/`.md`, the performance archive, `images.lock.json`, SBOMs, the bring-up results; for `v1.0.0` also the report and slides PDFs (PLT-DEL-03) |
| `pin`     | opens `chore(release): pin vX.Y.Z image digests`, which points `compose.yaml` on `main` at the new digests. PRs opened by `GITHUB_TOKEN` do not start CI: **close and reopen the PR once** so the required checks run, then a second member approves it                                                             |
| `deploy`  | calls `deploy.yml`, which **waits for approval** in the `production` environment                                                                                                                                                                                                                                    |

### 5.3 Deploy (a member other than the tagger)

1. Open the run → **Review deployments** → approve `production`. The deploy job then:
   - resolves the three digests from the release's `images.lock.json`;
   - SSHes to `deploy@<host>` with the pinned host key, checks out the tag in `/srv/plotinium`, and runs `ops/deploy.sh vX.Y.Z --project prod` under `flock`: pre-deploy backup to R2 (`--label pre-vX.Y.Z`), `pull`, `up -d --wait --wait-timeout 240` (db, then app with its expand-only migrations, then web), smoke, automatic rollback to the previous good tag on any failure, image prune, one JSON line in `/srv/plotinium/deploys.log`;
   - checks that `.env.images` on the VPS holds exactly the released digests (D-5);
   - smoke-tests from outside: `/api/readyz` is 200 with `"status":"ready"`, `/version.json` names the tag, and COOP, COEP, CSP and HSTS headers are present.
2. Expect a 2–5 s gap: every WebSocket closes with 1012 and clients resume from the per-owner feed; leases survive because they live in PostgreSQL (§3.11.3).
3. **First deploy only:** read the generated accounts once and write them on paper (§3.3):

   ```sh
   ssh deploy@<host> 'cd /srv/plotinium && docker compose -p plotinium logs app' | grep -A 20 'FIRST-START CREDENTIALS'
   ```

   The block is printed only on the first start of an empty database; clear your terminal scrollback afterwards.

Manual deploy, if GitHub Actions is down (still a released tag, still by digest):

```sh
ssh deploy@<host>
cd /srv/plotinium && git fetch --tags && git checkout --detach vX.Y.Z
set -a; . /etc/plotinium/backup.env; set +a
PLOTINIUM_REPO=<org>/plotinium GITHUB_ACTOR=$USER DEPLOY_APPROVER=<second member> ops/deploy.sh vX.Y.Z
```

### 5.4 OFF-05 during a gate or the demo (hash-only patch)

1. At T-1, R5 tags `vX.Y.(Z+1)` whose only change is the version and a CHANGELOG line (instructor agreement recorded). `release.yml` runs up to the deploy job and **waits**.
2. During the demo a member other than the tagger approves it (about 60–90 s to healthy).
3. The open desktop sees a newer `/version.json`; the new Service Worker installs and waits; the taskbar shows **Restart to update**; `reboot` activates it and `uname` shows the new build.

---

## 6. Rollback

Images are immutable and production migrations are expand-only, so the previous release runs on the newer schema (D-6). `down` migrations are **never** run on production.

- **Automatic.** `ops/deploy.sh` rolls back by itself when `up --wait` or its smoke check fails, and the job fails.
- **By hand.** Actions → **deploy** → Run workflow → `tag` = the previous release, `backup` unticked if you are rolling back right after a failed deploy (the pre-deploy backup of the failed attempt already exists). The same approval applies.
- **Check.** `/version.json` shows the previous version; `tail -n 2 /srv/plotinium/deploys.log` shows `rolled-back` or `ok`; open an issue with the cause and fix forward with a patch tag.
- **Drill.** Once before P2 and once before the freeze: deploy the current tag, roll back to the previous one, redeploy the current one; record the timings in `docs/evidence/deploy/`.

---

## 7. Backups to Cloudflare R2 with rclone

**Design (DB-01, OPS-14).** `ops/backup.sh` takes a snapshot-consistent `pg_dump -Fc` inside the `db` container, writes a manifest (tree checksum, row counts, schema version, image references, blob list) for the same snapshot, then `rclone copy` (never `sync`) of the dump, the manifest and the blob directory to the bucket. Retention: 7 daily and 4 weekly dumps locally in `/var/backups/plotinium`. The systemd timer `plotinium-backup.timer` runs it at 21:00 UTC (02:00 PKT); `ops/deploy.sh` runs it before every deploy. Swap pages are not backed up.

### 7.1 Create the bucket and the tokens (once)

1. Cloudflare dashboard → R2 → Create bucket `plotinium-backups`, location jurisdiction **EU**.
2. R2 → Manage API tokens → create **two** tokens scoped to that bucket only:
   - `plotinium-backup-rw`: Object Read & Write, for the VPS;
   - `plotinium-drill-ro`: Object Read only, for the weekly CI drill (§3.2).
3. Note the account's S3 endpoint `https://<account-id>.r2.cloudflarestorage.com` (EU jurisdiction: `https://<account-id>.eu.r2.cloudflarestorage.com`).

### 7.2 Configure rclone on the VPS (as `deploy`)

```sh
umask 077
RCLONE_CONFIG=/srv/plotinium/secrets/rclone.conf rclone config create r2 s3 \
  provider=Cloudflare env_auth=false \
  endpoint=https://<account-id>.eu.r2.cloudflarestorage.com \
  access_key_id=<rw key id> secret_access_key=<rw secret> \
  acl=private no_check_bucket=true
chmod 0600 /srv/plotinium/secrets/rclone.conf
RCLONE_CONFIG=/srv/plotinium/secrets/rclone.conf rclone lsd r2:     # lists plotinium-backups
```

Type the key and secret interactively (`rclone config`) if you do not want them in your shell history; either way run `history -c` afterwards. `/etc/plotinium/backup.env` already sets `RCLONE_REMOTE=r2:plotinium-backups` and `RCLONE_CONFIG`.

### 7.3 First backup and checks

```sh
sudo systemctl start plotinium-backup.service   # an admin, or as deploy:
set -a; . /etc/plotinium/backup.env; set +a; /srv/plotinium/ops/backup.sh --label manual
cat /srv/plotinium/state/backup-last.json       # {"result":"ok", ...}
RCLONE_CONFIG=/srv/plotinium/secrets/rclone.conf rclone ls r2:plotinium-backups/dumps | tail -4
systemctl list-timers 'plotinium-*'
```

A failed backup exits non-zero and records `"result":"failed"` in `backup-last.json`. The 6-hourly smoke job treats a backup older than 26 hours as a failure (`OPS-14.backup-age`). Cost: R2's free tier covers 10 GB-month; a 100k-inode dump with vectors was about 43 MB _(pilot figure — re-measure on the lab machine)_.

---

## 8. Restore and the restore drill

### 8.1 Weekly drill (DB-01, OPS-14; RTO target ≤ 10 min)

On the VPS, without touching production data:

```sh
set -a; . /etc/plotinium/backup.env; set +a
ops/restore-drill.sh                 # newest remote manifest (RCLONE_REMOTE set), or a local one
ops/restore-drill.sh --fresh-backup  # take a local backup first, then drill it
```

It restores into the scratch database `plotinium_drill`, verifies that the tree checksum equals the manifest, that probes P1–P9 return no rows and that every referenced blob exists, prints a result JSON **with no data in it**, and drops the scratch database. Commit the JSON by PR as `docs/evidence/deploy/restore-<YYYY-MM-DD>.json`. **A failed drill blocks the next tag.** The hosted CI version (`restore-drill.yml`, read-only R2 token, weekly and before each gate) is TODO(R5).

### 8.2 Real restore (disaster; RPO 24 h)

1. Declare the incident; stop deploys (do not approve pending ones).
2. Fetch the chosen backup: `rclone copy r2:plotinium-backups/dumps/<name>.manifest.json /var/backups/plotinium/` and the matching `.dump`.
3. `ops/restore.sh /var/backups/plotinium/<name>.manifest.json` stops `app`, verifies the dump's SHA-256, drops and recreates the database, runs `pg_restore -j 2 --exit-on-error`, copies missing blobs from R2, verifies checksum, probes and blobs, runs `VACUUM (ANALYZE)` and starts `app`. It exits non-zero on any mismatch.
4. If the `dbsecrets` volume was lost with the host, the `db` image generates new passwords at start; set them on the roles with `ops/rotate-db-passwords.sh` (TODO R5) before starting `app`.
5. Check `/api/readyz`, log in as a demo user, and run `fsck --server` as root in the OS.

---

## 9. Monitoring with UptimeRobot

**Design (OPS-15).** An external monitor, because a 5-minute Actions cron would burn about 8,600 minutes a month.

1. Create a free UptimeRobot account owned by the team email; add all five members as alert contacts (email and the mobile app).
2. Monitor 1: type **Keyword**, URL `https://<domain>/api/readyz`, keyword `"status":"ready"` (the server answers 200 with `{"status":"ready",…}` when ready and 503 otherwise), alert when the keyword is **missing**, interval 5 minutes.
3. Monitor 2: type **HTTP(s)**, URL `https://<domain>/version.json`, interval 5 minutes.
4. Enable SSL-expiry and domain-expiry notifications (14 days).
5. Create a public status page with both monitors and link it from the README (the availability evidence for P2–P5).
6. Outage response: read the alert, `ssh deploy@<host>`, `docker compose -p plotinium ps`, `docker compose -p plotinium logs --tail 200 app`, `df -h`, `cat /srv/plotinium/state/backup-last.json`. If the VPS is gone during a gate week, run the gate on the local stack while rebuilding from R2 (§1.6, target ≤ 30 min).

The deep smoke check every 6 hours (`smoke-prod.yml`: guest login to `desktop-interactive`, backup age, disk, certificate expiry through the forced-command health key) is TODO(R5) with `ops/health-report.sh`.

---

## 10. Leaked-key procedure

**Triggers:** a gitleaks alert; a provider notice; unexpected LLM spend (budget alerts at 50, 80 and 100 %); a key seen in a log, screenshot, chat, artifact or commit. **Owner:** R4 for the LLM key, R5 for everything else; each is the other's backup. Spec §18: "A leaked key must be revoked at once and reported in SECURITY.md."

| Step | Within | Action                                                                                                                                                                                                                                                                                                                           |
| ---- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | T+0    | Say it in the team channel; name the owner; stop sharing the artifact that leaks it                                                                                                                                                                                                                                              |
| 2    | 15 min | **Revoke first.** LLM key: Anthropic console → API keys → disable/delete. Do this before any investigation                                                                                                                                                                                                                       |
| 3    | 30 min | New key with a provider-side spend limit → on the VPS: `( IFS= read -rs k; printf '%s' "$k" > /srv/plotinium/secrets/anthropic_api_key )`, mode 0400 → `docker compose -p plotinium -f compose.yaml -f compose.prod.yaml --env-file .env --env-file .env.images up -d --no-deps app` → check `/api/readyz` and `/api/llm/health` |
| 4    | 2 h    | Compare the provider's usage for the leak window with our `llm_requests`; unexplained calls are abuse and their cost goes in the record                                                                                                                                                                                          |
| 5    | 24 h   | Remove the value where it leaked (delete an unmerged branch, a public artifact, image or log). **Do not rewrite `main`'s history**: the key is already dead and force pushes are disabled; the record states that the value in history is revoked                                                                                |
| 6    | 24 h   | Add a row to the incident log in [SECURITY.md](../SECURITY.md) (date, what, where, detected, revoked at, rotated and redeployed at, recorded by)                                                                                                                                                                                 |
| 7    | 1 week | Retrospective: a new detection rule, test or process change, linked from the incident row                                                                                                                                                                                                                                        |

Other secrets follow the same steps, with step 2 replaced by:

| Secret                     | Revoke and rotate                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Database password          | `ops/rotate-db-passwords.sh` (TODO R5): `ALTER ROLE … PASSWORD`, swap the file, restart `app`              |
| Session tokens             | revoke all sessions (`cli revoke-sessions --all`, TODO in backend-api) or of one user                      |
| CI deploy key / member key | delete the line from `~deploy/.ssh/authorized_keys` at once; issue a new pair; update `VPS_SSH_KEY`        |
| R2 token                   | Cloudflare → R2 → API tokens → roll; update `rclone.conf` (and the CI read-only secret)                    |
| Hetzner API token          | Hetzner console → Security → API tokens → delete                                                           |
| TLS key                    | `docker compose -p plotinium exec web rm -rf /data/caddy/certificates` and restart `web` (Caddy re-issues) |

The procedure is rehearsed once with a dummy key before the P4 gate (SEC-18).

---

## 11. Gate-week checklist

| When | Check                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T-7  | Restore drill passed this week (§8.1); UptimeRobot green for 7 days; `ops/provision.sh verify` all PASS; disk below 85 %; LLM budget ≥ USD 20 remaining; certificate valid > 14 days |
| T-7  | No unattended-upgrades reboot pending (`/var/run/reboot-required`); if one is, reboot by hand now, not in the gate week                                                              |
| T-1  | Tag and deploy (§5); the bring-up job passed on amd64 (and arm64); pin PR merged; examiner passwords reset, printed on paper, sealed                                                 |
| T-1  | Demo profile if needed: `LEASE_TTL_MS=15000` in `/srv/plotinium/.env`, redeploy; hash-only patch tag prepared for OFF-05 (§5.4)                                                      |
| T-0  | Nobody deploys during the gate except the OFF-05 approval; one member watches UptimeRobot                                                                                            |
| T+1  | Rotate the examiner passwords; remove `LEASE_TTL_MS`; add the gate evidence to `docs/evidence/gates/`                                                                                |
