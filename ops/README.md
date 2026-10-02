# ops/

Operations scripts for the production host (Hetzner CX33; fallback OVHcloud VPS-2) and the examiner stack.
Spec: [specs/14-devops/deployment-and-ci.md](../specs/14-devops/deployment-and-ci.md) and [specs/09-database/database.md](../specs/09-database/database.md) §3.30.

| File                         | Purpose                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/entrypoint.sh`           | `db` image entrypoint: generates `owner_password` and `app_password` into the `dbsecrets` volume at first start                             |
| `db/initdb.d/10-app-role.sh` | creates role `plotinium_app` with the generated password (once, on an empty data directory)                                                 |
| `caddy/csp-hash.ts`          | build step: the Content-Security-Policy with the SHA-256 of every inline script and style of `index.html`                                   |
| `caddy/prod.d/hsts.caddy`    | production-only headers, mounted by `compose.prod.yaml`                                                                                     |
| `web-placeholder/`           | the static page the `web` image ships while `web/` cannot be built yet                                                                      |
| `backup.sh`                  | snapshot-consistent `pg_dump -Fc` plus manifest (tree checksum, counts, schema version, blob list); `rclone copy` to R2; 7 daily + 4 weekly |
| `restore.sh`                 | restore a manifest, verify checksum, probes P1-P9 and blob presence, `VACUUM (ANALYZE)`                                                     |
| `restore-drill.sh`           | the weekly drill: restore into `plotinium_drill`, verify, print the RTO result JSON, drop the scratch database                              |
| `deploy.sh`                  | deploy a released tag by image digest under `flock`, with pre-deploy backup, smoke test and automatic rollback                              |

Not yet written (R5): `cloud-init.yaml`, `rotate-db-passwords.sh`, `health-report.sh`, `buy-server.sh`, the remote blob prune, `compose.staging.yaml`.

- **Primary owner:** R5 QA / DevOps & Integration Engineer
- **Secondary reviewer:** R1 Kernel (R2 for the database scripts)

Never commit credentials, host keys or `.env` files here (spec §18). Production secrets live only under `/srv/plotinium/secrets` (mode 0400/0600).
