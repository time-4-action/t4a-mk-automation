# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow

Changes go **straight into `main`**:

```
feature branch  →  PR into main  →  merge deploys to PRODUCTION
```

1. **Branch off `main`** (`git fetch && git checkout -b fix/... origin/main`). Name it `feat/...`, `fix/...`, `chore/...`, `docs/...`.
2. **Open the PR against `main`** (`gh pr create`). Grega reviews and merges; don't merge it yourself.
3. **Merging into `main` deploys to production** (`https://mkauto.time-4-action.com`): the `ci` run builds the image and deploys it.
4. **Never push or commit directly to `main`**, and never force-push it.
5. There is no dev server (switched off 2026-11-06). Try changes locally (`npm run dev` against the Metakocka test system) before the PR.
6. After a merge, a deploy is only done when the `ci` run is green and `/healthz` reports the merge commit as `version` and `env: production`. Check before saying it is deployed.

Dependabot PRs target `main` too.

## Environments

| | local (laptop) | production |
|---|---|---|
| Branch | any | `main` |
| URL | `http://localhost:3000` | `https://mkauto.time-4-action.com` |
| Image | none (`npm run dev`) or a local build | built: `ghcr.io/time-4-action/t4a-mk-automation:<sha>` → `:latest` once verified |
| Server | your machine | t4a (`/srv/mk-automation`), behind Traefik |
| Compose | root `docker-compose.yml` (local build) | `deploy/docker-compose.t4a.yml` (loopback port 3000) |
| Metakocka | `devmainsi.metakocka.si` (`MK_BASE_URL`) | `main.metakocka.si` |
| `APP_ENV` | not set | `production` |

There is no dev server any more (switched off 2026-11-06).

`/healthz` (no auth, no DB) returns `{ ok, version, env }`; every page shows the version badge
(`public/version.js`), blue `DEV · <sha>` outside production.

## Safety lock — never weaken it

`src/config/envGuard.js`: unless `APP_ENV=production`, the app refuses to start if Metakocka points at
`main.metakocka.si` or `BETTER_STACK_WH_SYNC_HEARTBEAT` is set, and an axios interceptor blocks those hosts
on every call.

- Any new outbound integration that has a production endpoint must be added to `PRODUCTION_HOSTS` and,
  if configured by a setting, to the startup check.
- Settings must never silently default to a production address in non-production code paths.
- Never put production credentials in a local `.env`, examples, tests or commits.
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

`.github/workflows/deploy.yml` (workflow `ci`): `check` → `image` → `deploy` → `verify`. A push to `main`
builds `:<sha>` and deploys it to production by digest; once the public `/healthz` reports that `version` and
`env: production`, it is tagged `:latest`. Every deploy waits for
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
