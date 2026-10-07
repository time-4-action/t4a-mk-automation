# Deployment

`.github/workflows/deploy.yml` (workflow `ci`) runs `check` → `deploy` → `verify`.

**check** runs on every pull request and every push to `main`: `npm ci`, a
`node --check` syntax pass over every tracked `.js` file, and a full
`docker build` (not pushed), so a broken Dockerfile or a native module
(`better-sqlite3`) that no longer installs fails the pull request. A newer push
to a pull request cancels its running check; runs on `main` are queued, so
pushes deploy strictly in order.

**deploy** runs only on `main` after a green check, one at a time. It builds the
image on GitHub Actions with the commit SHA baked in as `APP_VERSION`, pushes
`ghcr.io/time-4-action/t4a-mk-automation:<sha>` and `:latest` to GitHub
Container Registry, then SSHes to the VM as `deploy` and, in
`/data/stack/apps/time-4-action/mk-automation`:

1. records the image the running `t4a-mk-automation` container uses;
2. logs in to `ghcr.io` with the job's own `GITHUB_TOKEN` (valid only while the
   job runs; logged out again on exit, so the VM stores no registry
   credential), `docker compose pull` (three attempts) and `docker compose up -d`
   with `APP_IMAGE` exported to the new SHA;
3. waits up to 60 s for `http://127.0.0.1:3000/healthz` to answer 200;
4. checks the container reports `APP_VERSION` equal to the commit SHA.

If 3 or 4 fails it prints the logs, rolls back to the recorded image and fails
the run. **verify** then requests `/healthz` on the public URL
(`https://mkauto.time-4-action.com`, override with the `PRODUCTION_URL`
repository variable).

`/healthz` needs no API key and touches neither SQLite nor Metakocka, so an
outage there never triggers a rollback.

The deploy only swaps images. Everything mutable — `.env`, `cron.json`,
`patrik.db`, `public/` — lives in the mounted `/data` directory and survives
every deploy and rollback. The server copy of the compose file is
`deploy/docker-compose.yml` (the root one is for local builds). To go back to an
older release, re-run that commit's workflow, or on the server:
`export APP_IMAGE=ghcr.io/time-4-action/t4a-mk-automation:<sha> && docker compose up -d`
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

## Dependency updates

`.github/dependabot.yml` opens at most one grouped pull request per ecosystem a
month (npm minor + patch, GitHub Actions); each goes through `check` like any
other pull request. Major npm versions are left to a deliberate upgrade.
