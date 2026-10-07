# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow

Work flows through the `dev` branch — **never PR a feature branch directly into `main`.**

```
feature branch  →  PR into dev  →  deploys to the DEV server  →  (tested)  PR dev → main  →  deploys to PRODUCTION
```

1. **Branch off `dev`** for every change (`git fetch && git checkout -b fix/... origin/dev`). Name it `feat/...`, `fix/...`, `chore/...`, `docs/...`.
2. **Open the PR against `dev`**: always pass `--base dev` to `gh pr create` — the repository default is still `main`.
3. **Merging into `dev` deploys to the dev server** (`https://mkauto.dev.time-4-action.com`). Check it there before promoting.
4. **`dev` → `main` is a release**: a separate PR from `dev` into `main`, opened only when the user asks to release. Merging it deploys to production (`https://mkauto.time-4-action.com`).
5. **Never push or commit directly to `dev` or `main`**, and never force-push them. Merges happen through PRs, by the user unless they ask otherwise.
6. **Hotfix** (only when the user asks for one): PR the fix into `dev`, let it deploy green there, then open `dev` → `main` right away. A PR straight into `main` cannot deploy: production only runs images that were built and verified on `dev`.
7. After a merge, a deploy is only done when the `ci` run is green and `/healthz` on that environment reports the expected `version` — the commit the image was built from on `dev` (for a `dev` → `main` release, the `dev` tip, not the merge commit). Check before saying it is deployed.

Dependabot PRs target `dev` and follow the same path.

## Environments

| | dev | production |
|---|---|---|
| Branch | `dev` | `main` |
| URL | `https://mkauto.dev.time-4-action.com` | `https://mkauto.time-4-action.com` |
| Image | built once: `ghcr.io/time-4-action/t4a-mk-automation:<sha>` → `:<sha>-verified`, `:dev` | no build: the same digest, promoted → `:latest` |
| Server | dev VM, behind Traefik | production VM, behind nginx |
| Compose | `deploy/docker-compose.dev.yml` (loopback port 13010) | `deploy/docker-compose.yml` (port 3000) |
| Metakocka | `devmainsi.metakocka.si` (`MK_BASE_URL`) | `main.metakocka.si` |
| `APP_ENV` | not set | `production` |

`/healthz` (no auth, no DB) returns `{ ok, version, env }`; every page shows the version badge
(`public/version.js`), blue `DEV · <sha>` outside production.

## Safety lock — never weaken it

`src/config/envGuard.js`: unless `APP_ENV=production`, the app refuses to start if Metakocka points at
`main.metakocka.si` or `BETTER_STACK_WH_SYNC_HEARTBEAT` is set, and an axios interceptor blocks those hosts
on every call.

- Any new outbound integration that has a production endpoint must be added to `PRODUCTION_HOSTS` and,
  if configured by a setting, to the startup check.
- Settings must never silently default to a production address in non-production code paths.
- Never put production credentials in the dev `.env`, examples, tests or commits.
- All outbound HTTP goes through the default `axios` instance so the interceptor sees it — don't use
  `axios.create()`, `fetch` or `https` directly for external calls.

## Commands

```bash
npm ci                 # install
npm run dev            # NODE_ENV=development, port 3000 (needs a .env with MK_BASE_URL=devmainsi)
npm start              # NODE_ENV=production
docker compose up --build   # local image build (root docker-compose.yml, data in ./tmp/data)
```

There is no test suite. CI's `check` job runs `npm ci`, `npm run lint` (ESLint, `eslint.config.js`:
`eslint:recommended` — undefined names, unused and unreachable code, syntax errors) and, on pull
requests, a full `docker build`; run lint locally before opening a PR:

```bash
npm run lint
```

Fix lint findings rather than disabling rules. The only `eslint-disable` comments are on the imports and
helper kept for the retired ProMode block in `index.js`. Inline `<script>` blocks in `public/*.html` are not
linted.

## CI/CD

`.github/workflows/deploy.yml` (workflow `ci`): `check` → `image` → `deploy` → `verify`, **build once,
promote the same image**. A push to `dev` builds `:<sha>` once and deploys it by digest; once the public
`/healthz` reports that `version` and `env: development`, it is tagged `:<sha>-verified`. A push to `main`
never builds: it finds the `dev` commit with main's exact git tree whose image is verified and deploys that
digest (then `/healthz` must report `env: production`, and it is tagged `:latest`). Every deploy waits for
`/healthz` and `APP_VERSION` on the VM and rolls back to the previous image otherwise. Never bake
environment-specific values into the image — they belong in `/data/.env`. Details and server setup:
`docs/deployment.md`.

The servers only swap images. `.env`, `cron.json`, `patrik.db` and `public/` live in the mounted `/data`
directory on each server and are edited by hand there.

## Architecture

One Express app (`index.js`, port 3000) that syncs Metakocka data one way, **T4A → CREAGLOBE** (T4A is the
source of truth and is never written to):

- **Warehouse stock**, **products**, **customers** (partners) and **pricelists**, each with a cron schedule
  from `cron.json` (`CRON_FILE_PATH`), a "run now" API, and run history in SQLite (`better-sqlite3`,
  `DB_FILE_PATH`; tables `*_sync_log`, `sync_runs`, `pricelist_map`).
- Sync logic lives in `src/services/*SyncService.js`; Metakocka endpoints in `config/config.json`.
- `/api/v1/*` routes; mutating ones require the `x-api-key` header (`API_KEY`). Schedules are validated with
  both `cron-validator` and `node-cron`'s `validate`; an invalid schedule in `cron.json` leaves that job
  unscheduled instead of crashing.
- Static dashboards in `public/<sync>/` (plus `notes/` pages), served by Express.
- Env loading: `cron.js` loads `ENV_FILE_PATH` (`/data/.env` in the image); `envGuard` must stay required
  after it in `index.js`.

`design.md` is the long-form design guide (engine, API, data model, and how `../t4a-admin` uses this API).
Metakocka REST references are in `docs/`.
