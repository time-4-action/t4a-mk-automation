# Deployment

`.github/workflows/deploy.yml` (workflow `ci`) runs `check` → `image` → `deploy` →
`verify`. Pull requests go straight into `main`, and merging one deploys production:

```
feature/fix branch ── PR ──► main ── push ──► build :<sha> ──► PROD (t4a) ──► verified ──► tag :latest
```

There is no dev server any more (switched off 2026-11-06): try changes locally first.

| | `main` |
|---|---|
| GitHub environment | `production` |
| Image | built: `:<sha>` → `:latest` |
| SSH secrets | `PROD_DEPLOY_*` (overridden on the `production` environment, below) |
| Server compose | `deploy/docker-compose.t4a.yml` (t4a, `/srv/mk-automation`) |
| Public check | `https://mkauto.time-4-action.com/healthz` (`PRODUCTION_URL` variable) |
| `APP_ENV` in `/data/.env` | `production` |

The image is environment-neutral: whether it behaves as production is decided at
runtime by `APP_ENV` in `/data/.env` (see Safety lock). Don't add per-environment
build args.

**check** runs on every pull request and every push: `npm ci` and `npm run lint`
(ESLint, `eslint.config.js`). On pull requests it also runs a full `docker build`
(not pushed), so a broken Dockerfile or a native module (`better-sqlite3`) that
no longer installs fails the pull request. A newer push to a pull request cancels
its running check; runs on `main` are queued, so pushes deploy strictly in order.

**image** produces the image to deploy as an immutable `image@sha256:…` reference
plus the commit it was built from:

it builds the image with the commit SHA baked in as `APP_VERSION` and pushes
`ghcr.io/time-4-action/t4a-mk-automation:<sha>`.

**deploy** runs one at a time per environment. It SSHes to the VM as `deploy`
and, in the `DEPLOY_DIR` variable's directory (`/srv/mk-automation` on t4a; the default,
`/data/stack/apps/time-4-action/mk-automation`, was t2's):

1. records the image the running `t4a-mk-automation` container uses;
2. logs in to `ghcr.io` with the job's own `GITHUB_TOKEN` (valid only while the
   job runs; logged out again on exit, so the VM stores no registry
   credential), `docker compose pull` (three attempts) and `docker compose up -d`
   with `APP_IMAGE` exported to the image digest;
3. waits up to 60 s for `http://127.0.0.1:3000/healthz` to answer 200;
4. checks the container reports `APP_VERSION` equal to the image's source commit.

If 3 or 4 fails it prints the logs, rolls back to the recorded image and fails
the run. **verify** then requests `/healthz` on the public URL and requires
`ok: true`, `version` = the image's source commit and `env` = this environment
(`production`). Only then is the image tagged `:latest`.

`/healthz` needs no API key and touches neither SQLite nor Metakocka, so an
outage there never triggers a rollback.

The deploy only swaps images. Everything mutable — `.env`, `cron.json`,
`patrik.db`, `public/` — lives in the mounted `/data` directory and survives
every deploy and rollback. The server copy of the compose file is
`deploy/docker-compose.yml` (the root one is for local builds). To go back to an
older release, re-run that commit's workflow, or on the server:
`export APP_IMAGE=ghcr.io/time-4-action/t4a-mk-automation:<sha>-verified && docker compose up -d`
(a `docker login ghcr.io` first if the package is private).

## GitHub settings

The image lives in GHCR as `ghcr.io/time-4-action/t4a-mk-automation`. Pushing
and pulling use the workflow's `GITHUB_TOKEN` (`packages: write` on the deploy
job), so there is no registry secret. The `org.opencontainers.image.source`
label in the Dockerfile links the package to this repository.

Organization secrets (shared with t4a-admin and the other repos on this VM):
`PROD_DEPLOY_HOST`, `PROD_DEPLOY_SSH_KEY`, `PROD_DEPLOY_FINGERPRINT`. They must
be made available to this repository (organization settings → Secrets → repository
access). A `production` environment must exist in the repository settings.

The SSH user is `deploy` unless the `DEPLOY_USER` repository variable names
another. It must be in the `docker` group, be able to write the server
directory, and have `curl`.

## Production on t4a (since 2026-11-06)

Production moved from t2 to t4a (Hetzner, `77.42.42.60`; time-4-action/t4a-infra,
`servers/t4a`). What points the deploy there is set on the `production` environment
only (environment secrets win over the organization secrets of the same name):

| On the `production` environment | Value |
|---|---|
| secret `PROD_DEPLOY_HOST` | `77.42.42.60` |
| secret `PROD_DEPLOY_SSH_KEY` | the private key `github-actions@t4a-mk-automation-t4a` (its public half is in `/home/deploy/.ssh/authorized_keys` on t4a) |
| secret `PROD_DEPLOY_FINGERPRINT` | t4a's **ECDSA** host key, `SHA256:2wkXWs0QETKFiXKXbxbJRASeNd9I6zigPKVQGBtwfTk` (the action's Go SSH client picks ECDSA; the Ed25519 fingerprint fails with "host key fingerprint mismatch") |
| variable `DEPLOY_DIR` | `/srv/mk-automation` |

On t4a, `/srv/mk-automation` (owned by `deploy`) holds `docker-compose.yml`
(= `deploy/docker-compose.t4a.yml`: Traefik labels for `mkauto.time-4-action.com`,
loopback port 3000 for the health check) and `data/` (`.env`, `cron.json`,
`patrik.db`, `public/`), mounted as `/data`. DNS: a proxied CNAME `mkauto` →
`production.time-4-action.com` in the `time-4-action.com` zone, which overrides the
`*` wildcard that still points at t2.

The cutover: between two syncs (they run at :00/:15/:30/:45 and take seconds),
`docker compose stop` on t2, copy `patrik.db`, `cron.json`, `.env` and `public/`,
`docker compose up -d` on t4a with the same image, then the DNS record. The t2
container and its directory are stopped, not deleted. To go back: delete the DNS
record and the four environment settings above, start t2 again
(`docker compose start` there) after copying `patrik.db` back, so no sync history
is lost.

Note: the app does not handle `SIGTERM`, so `docker compose stop` waits 10 s and
kills it (exit 137). Stop it between syncs.

## Server setup (once) — migrating from Docker Hub

(History: this was the t2 setup, before the move to t4a.)

The server used to run `time4action/t4a-mk-automation` from Docker Hub, pushed
by hand with `update.sh`. To switch:

```sh
cd /data/stack/apps/time-4-action/mk-automation
cp docker-compose.yml docker-compose.yml.dockerhub   # keep the old one
# replace docker-compose.yml with deploy/docker-compose.yml from this repo
sudo chown -R deploy: .  # or otherwise give the deploy user write access
```

Then merge to `main` (or run the workflow by hand). The Docker Hub container
stays up until then, so if the first GHCR deploy fails it rolls back to the
Docker Hub image. The compose file must use `${APP_IMAGE...}`: a copy with a fixed
`image:` ignores `APP_IMAGE`, so every deploy fails its `APP_VERSION` check and
rolls back.

Once it is running from GHCR, the Docker Hub repository can be deleted.

## Safety lock

`src/config/envGuard.js` makes sure nothing outside production touches
production. Unless `/data/.env` has `APP_ENV=production`, the app:

- **refuses to start** if Metakocka points at `main.metakocka.si` or
  `BETTER_STACK_WH_SYNC_HEARTBEAT` is set, and logs which setting is wrong;
- **blocks every outbound call** to `main.metakocka.si` or Better Stack, as a
  backup.

Laptops (local development) point at the Metakocka test system with
`MK_BASE_URL=https://devmainsi.metakocka.si/rest/eshop`
(`config/config.json`'s `baseUrl` is the production default). `/healthz` reports
`env`, and outside production the version badge on every page turns blue and
reads `DEV · <sha>`.

**Only the production `.env` may contain `APP_ENV=production`.** If it is
missing there, production refuses to start and the deploy rolls back.

## Dependency updates

`.github/dependabot.yml` opens at most one grouped pull request per ecosystem a
month (npm minor + patch, GitHub Actions); each goes through `check` like any
other pull request. Major npm versions are left to a deliberate upgrade.
