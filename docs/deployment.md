# Deployment

`.github/workflows/deploy.yml` (workflow `ci`) runs `check` → `image` → `deploy` →
`verify`. The image is **built once, on `dev`, and production gets that same image** —
byte-for-byte what was verified on the dev server, never a rebuild.

There are two environments, one per long-lived branch:

```
feature/fix branch ── PR ──► dev ── push ──► build :<sha> ──► DEV VM ──► verified ──► tag :<sha>-verified
                               │
                               └── PR dev → main (once tested on dev)
                                         main ── push ──► NO build: same digest ──► PROD VM ──► tag :latest
```

Feature pull requests target `dev`. When a batch has been tried on dev, a pull
request from `dev` into `main` releases it. **Hotfixes go through `dev` too**
(PR into `dev`, wait for it to deploy green, then `dev` → `main`): code that was
never built and verified on `dev` has no image `main` may deploy, and the run
fails before touching production.

| | `dev` | `main` |
|---|---|---|
| GitHub environment | `development` | `production` |
| Image | built: `:<sha>` → `:<sha>-verified`, `:dev` | promoted digest → `:latest` |
| SSH secrets | `DEV_DEPLOY_*` | `PROD_DEPLOY_*` |
| Server compose | `deploy/docker-compose.dev.yml` | `deploy/docker-compose.yml` |
| Public check | `https://mkauto.dev.time-4-action.com/healthz` (`DEV_URL` variable) | `https://mkauto.time-4-action.com/healthz` (`PRODUCTION_URL` variable) |
| `APP_ENV` in `/data/.env` | **not set** | `production` |

The image is environment-neutral: whether it behaves as production is decided at
runtime by `APP_ENV` in `/data/.env` (see Safety lock). Don't add per-environment
build args — that would break build-once.

**check** runs on every pull request and every push: `npm ci` and `npm run lint`
(ESLint, `eslint.config.js`). On pull requests it also runs a full `docker build`
(not pushed), so a broken Dockerfile or a native module (`better-sqlite3`) that
no longer installs fails the pull request. A newer push to a pull request cancels
its running check; runs on `main` are queued, so pushes deploy strictly in order.

**image** produces the image to deploy as an immutable `image@sha256:…` reference
plus the commit it was built from:

- on `dev` it builds the image (the only build) with the commit SHA baked in as
  `APP_VERSION` and pushes `ghcr.io/time-4-action/t4a-mk-automation:<sha>`;
- on `main` it builds nothing: it takes main's git tree, finds the `dev` commit
  with the identical tree (the `dev` → `main` merge commit has the same tree as
  the `dev` tip) and an image tagged `:<sha>-verified`, and uses that digest.

**deploy** runs one at a time per environment. It SSHes to the VM as `deploy`
and, in
`/data/stack/apps/time-4-action/mk-automation`:

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
(`development` / `production`). Only then is the image tagged — `:<sha>-verified`
and `:dev` on dev (which makes it promotable), `:latest` in production.

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

## Server setup (once) — migrating from Docker Hub

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

Dev and laptops point at the Metakocka test system with
`MK_BASE_URL=https://devmainsi.metakocka.si/rest/eshop`
(`config/config.json`'s `baseUrl` is the production default). `/healthz` reports
`env`, and outside production the version badge on every page turns blue and
reads `DEV · <sha>`.

**Only the production `.env` may contain `APP_ENV=production`.** If it is
missing there, production refuses to start and the deploy rolls back.

## Dev environment (server setup, once)

The dev VM is a separate machine. Docker, the `deploy` user and its CI SSH key
are set up as on production, with their own key and the `DEV_DEPLOY_HOST`,
`DEV_DEPLOY_SSH_KEY`, `DEV_DEPLOY_FINGERPRINT` organization secrets.

DNS and TLS need no per-app work: Cloudflare has one `*.dev.time-4-action.com`
A record (DNS only, grey cloud) pointing at the dev VM, and Traefik
(`/data/stack/infra/traefik`) holds a Let's Encrypt wildcard certificate
renewed over the Cloudflare DNS API. An app gets its dev domain from the
`traefik.*` labels in its dev compose file and must join the external `web`
network.

For this app, in `/data/stack/apps/time-4-action/mk-automation` on the dev VM,
owned by `deploy`:

- `docker-compose.yml` = `deploy/docker-compose.dev.yml` (health-check port `127.0.0.1:13010`, since other dev apps use 3000);
- `.env` from `deploy/dev.env.example`: devmainsi credentials for **both** T4A
  and CREAGLOBE, no `APP_ENV`, no heartbeat. Never copy the production `.env`;
- `cron.json` (a copy of the repo's is fine — the schedules sync devmainsi).

## Dependency updates

`.github/dependabot.yml` opens at most one grouped pull request per ecosystem a
month (npm minor + patch, GitHub Actions); each goes through `check` like any
other pull request. Major npm versions are left to a deliberate upgrade.
