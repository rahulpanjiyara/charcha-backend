# Hostinger API deployment

The production workflow deploys this backend as a Docker Compose project through Hostinger's API. It does not log in to the VPS over SSH.

## One-time GitHub setup

In `rahulpanjiyara/charcha-backend`, open **Settings → Secrets and variables → Actions**.

Add these repository secrets:

- `HOSTINGER_API_KEY`: an API token created in Hostinger hPanel
- `MONGO_URL`: the production MongoDB connection string
- `JWT_SECRET`: a long, random production signing secret

Add these repository variables:

- `HOSTINGER_VM_ID`: `1301354`
- `CORS_ORIGIN`: `*` for the Expo mobile app, or a comma-separated allow-list when a web client is added

The repository must be public for a completely SSH-free deployment with Hostinger's official action. Hostinger requires a GitHub SSH deploy key when it needs to fetch a private repository.

## Deployment

Every push to `main` performs the following steps:

1. Installs the locked npm dependencies.
2. Compiles the TypeScript backend.
3. Builds the production Docker image as a validation step.
4. Sends the Compose project and environment to VPS `1301354` through the Hostinger API.

The Hostinger project name is `charcha-backend`. Node listens on port `3000` inside the container, while Docker binds it to `127.0.0.1:3003` on the VPS. Configure `https://charcha.loan-master.cloud` to proxy to `http://127.0.0.1:3003`.

The workflow can also be started manually from **Actions → Verify and deploy backend → Run workflow**.

## Verification

After deployment, verify:

```text
https://charcha.loan-master.cloud/health
```

A healthy response is:

```json
{"status":"ok","database":"connected"}
```
