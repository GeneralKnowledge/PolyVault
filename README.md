# PolyVault

Upload a file **once**; store it on **multiple free cloud providers** in parallel.

```bash
polyvault put ./hello.txt
```

`hello.txt` appears in every linked destination (local folders, S3-compatible, Google Drive, OneDrive) under a shared remote folder (default `PolyVault/`).

## Requirements

- Node.js 20+
- npm

## Install / build

```bash
npm install
npm run build
npm link          # optional: put `polyvault` on your PATH
```

Development without building:

```bash
npm run dev -- init
npm run dev -- put ./hello.txt
```

Config lives in `~/.polyvault/` (override with `POLYVAULT_HOME`). Secrets are stored in `secrets.json` with mode `0600`.

## Quickstart (local providers)

```bash
polyvault init

mkdir -p /tmp/pv-a /tmp/pv-b
polyvault provider add local --name a --path /tmp/pv-a
polyvault provider add local --name b --path /tmp/pv-b

echo 'hi' > hello.txt
polyvault put hello.txt

# → /tmp/pv-a/PolyVault/hello.txt
# → /tmp/pv-b/PolyVault/hello.txt

polyvault status
polyvault provider list
```

Partial failure (one bad destination) still uploads to the others and exits non-zero:

```bash
polyvault provider add local --name bad --path /tmp/this-is-a-file/nested
# (create a file at /tmp/this-is-a-file first)
polyvault put hello.txt
# ✓ a  ✓ b  ✗ bad   exit code 1
```

## Commands

| Command | Description |
|---------|-------------|
| `polyvault init` | Create config under `~/.polyvault/` |
| `polyvault provider add <kind>` | Link a provider (`local`, `s3`, `gdrive`, `onedrive`) |
| `polyvault provider list` | List linked providers |
| `polyvault put <file>` | Upload to all providers (or `--to name1,name2`) |
| `polyvault status` | Show providers + last put result |

`put` options:

- `--remote-dir <dir>` — remote folder (default `PolyVault`)
- `--to <names>` — comma-separated provider names

## S3-compatible (Cloudflare R2 / Backblaze B2 / MinIO)

```bash
polyvault provider add s3 \
  --name r2 \
  --endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --region auto \
  --bucket my-polyvault \
  --access-key-id <KEY> \
  --secret-access-key <SECRET>
```

**Backblaze B2** (S3-compatible API):

```bash
polyvault provider add s3 \
  --name b2 \
  --endpoint https://s3.us-west-004.backblazeb2.com \
  --region us-west-004 \
  --bucket my-polyvault \
  --access-key-id <keyID> \
  --secret-access-key <applicationKey>
```

**MinIO** (local):

```bash
polyvault provider add s3 \
  --name minio \
  --endpoint http://127.0.0.1:9000 \
  --region us-east-1 \
  --bucket polyvault \
  --access-key-id minioadmin \
  --secret-access-key minioadmin
```

## Google Drive OAuth

1. Open [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → enable **Google Drive API**.
2. Create OAuth client ID → application type **Desktop app** (or Web with loopback).
3. Add authorized redirect URI:

   ```
   http://127.0.0.1:8765/callback
   ```

4. Copy client ID and secret, then:

```bash
polyvault provider add gdrive --name gdrive \
  --client-id <CLIENT_ID> \
  --client-secret <CLIENT_SECRET>
```

A browser window opens; after consent, PolyVault stores the refresh token under `~/.polyvault/secrets.json`.

## Microsoft OneDrive OAuth

1. Open [Azure Portal](https://portal.azure.com/) → App registrations → **New registration**.
2. Supported account types: personal Microsoft accounts and/or work/school (use tenant `common` for both).
3. Under **Authentication**, add a platform → **Mobile and desktop** (or Web) with redirect URI:

   ```
   http://127.0.0.1:8765/callback
   ```

4. Create a client secret under **Certificates & secrets**.
5. API permissions: Microsoft Graph delegated `Files.ReadWrite`, `offline_access`.

```bash
polyvault provider add onedrive --name onedrive \
  --client-id <APP_ID> \
  --client-secret <SECRET> \
  --tenant common
```

## Example: put a `.txt`

```bash
echo 'hello from polyvault' > hello.txt
polyvault put hello.txt --remote-dir PolyVault
```

Every linked provider receives `PolyVault/hello.txt`. Failures are isolated: other destinations still succeed; the CLI prints a per-provider summary and exits `1` if any failed.

## Environment

| Variable | Meaning |
|----------|---------|
| `POLYVAULT_HOME` | Config directory (default `~/.polyvault`) |

## Project layout

```
src/
  cli.ts
  commands/     # init, provider, put, status
  config/       # ~/.polyvault load/save (0600 secrets)
  oauth/        # localhost redirect callback
  providers/    # local, s3, gdrive, onedrive
  util/
test/
```

## Roadmap

- **Encryption** — client-side encrypt before upload; decrypt on download (not in v1).
- **More providers** — Dropbox, Mega, WebDAV.
- **Cloud-to-cloud relay** — optional VM that copies between clouds without re-uploading from your laptop (out of scope for v1).
- Folder backup / incremental sync / manifests.

## License

MIT
