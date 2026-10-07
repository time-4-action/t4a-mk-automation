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
6. **Hotfix** (only when the user asks for one): branch off `main`, PR into `main`, then PR `main` back into `dev` so the branches don't diverge.
7. After a merge, a deploy is only done when the `ci` run is green and `/healthz` on that environment reports the merge commit — check before saying it is deployed.

Dependabot PRs target `dev` and follow the same path.

## Environments

| | dev | production |
|---|---|---|
| Branch | `dev` | `main` |
| URL | `https://mkauto.dev.time-4-action.com` | `https://mkauto.time-4-action.com` |
| Image | `ghcr.io/time-4-action/t4a-mk-automation:dev-<sha>`, `:dev` | `…:<sha>`, `:latest` |
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

There is no test suite or linter. CI's `check` job runs `npm ci`, `node --check` on every tracked `.js`
file and a full `docker build`; run the same locally before opening a PR:

```bash
git ls-files '*.js' ':!:public/**' | xargs -n1 node --check
```

## CI/CD

`.github/workflows/deploy.yml` (workflow `ci`): `check` → `deploy` → `verify`. Every PR and push runs
`check`. A push to `dev` or `main` builds the image, pushes it to GHCR and deploys over SSH to that branch's
server, waits for `/healthz` and `APP_VERSION == sha`, and rolls back to the previous image otherwise;
`verify` checks the public URL. Details and server setup: `docs/deployment.md`.

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
