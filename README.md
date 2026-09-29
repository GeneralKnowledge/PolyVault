# PolyVault

Upload a file **once** to a **free hub** (Cloudflare R2). Replicas are filled **from the hub**, not by uploading the original again.

```text
laptop ──(once)──► R2 hub (free)
                      │
                      ├── URL-pull ──► OneDrive Personal
                      └── free relay ─► Google Drive / OneDrive / …
```

```bash
polyvault put ./hello.txt
```

## Architecture

| Piece | Recommendation | Role |
|--------|----------------|------|
| **Hub** | Cloudflare R2 (S3 API) | Receives the original once. Free tier: 10 GB, free egress. |
| **OneDrive replica** | Graph upload-from-URL | Microsoft pulls from an R2 signed URL (no laptop bridge). |
| **Google Drive replica** | Free relay VM | Oracle Always Free streams `R2 → Drive` off your laptop. |
| **Fallback** | Laptop bridge | Only if relay/URL-pull unavailable: `hub → laptop → cloud`. |

Local hub + local replicas are supported for tests (`hub-copy`), but real multi-cloud should use R2 as hub.

## Install

```bash
npm install
npm run build
npm link   # optional
```

Config: `~/.polyvault/` (override with `POLYVAULT_HOME`). Secrets mode `0600`.

## Quickstart

### 1. Init + free R2 hub

```bash
polyvault init

polyvault hub set s3 \
  --name r2 \
  --endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --region auto \
  --bucket polyvault \
  --access-key-id <KEY> \
  --secret-access-key <SECRET>
```

### 2. Add replicas

```bash
polyvault provider add onedrive --name onedrive \
  --client-id <APP_ID> --client-secret <SECRET>

polyvault provider add gdrive --name gdrive \
  --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>
```

### 3. Optional: free relay (recommended for Drive)

On an **Oracle Always Free** VM (or any small always-on host):

```bash
git clone <this-repo> && cd PolyVault && npm install && npm run build
export RELAY_TOKEN="$(openssl rand -hex 24)"
export PORT=8787
npm run relay:prod
# open firewall for TCP 8787
```

On your laptop:

```bash
polyvault relay set --url http://YOUR_VM_IP:8787 --token "$RELAY_TOKEN"
```

### 4. Put once

```bash
echo 'hi' > hello.txt
polyvault put hello.txt
```

Expected modes:

- `hub-upload` — original → R2 only
- `onedrive-url-pull` — OneDrive pulls from R2 signed URL
- `relay` — VM streams R2 → Drive
- `hub-copy` — local tests
- `laptop-bridge` — last-resort fallback (prints a warning)

## Local test (no cloud)

```bash
polyvault init
polyvault hub set local --name hub --path /tmp/pv-hub
polyvault provider add local --name replica --path /tmp/pv-replica
echo hi > hello.txt
polyvault put hello.txt
# /tmp/pv-hub/PolyVault/hello.txt
# /tmp/pv-replica/PolyVault/hello.txt   (copied from hub)
```

## Commands

| Command | Description |
|---------|-------------|
| `polyvault init` | Create config |
| `polyvault hub set s3\|local` | Set free hub (R2 recommended) |
| `polyvault provider add <kind>` | Add replica |
| `polyvault provider list` | Show hub + replicas + relay |
| `polyvault relay set --url …` | Point at free relay VM |
| `polyvault relay clear` | Remove relay |
| `polyvault put <file>` | Upload once to hub; replicate |
| `polyvault status` | Hub/replicas/last put |

`put` options: `--to`, `--remote-dir`, `--bridge` (force laptop bridge).

## OAuth redirect URI

Google + Microsoft apps must allow:

```
http://127.0.0.1:8765/callback
```

See earlier setup notes for Drive API / Graph `Files.ReadWrite` + `offline_access`.

## Relay API

`POST /v1/replicate` with `Authorization: Bearer <token>`:

```json
{
  "sourceUrl": "https://…r2…/presigned-get",
  "remotePath": "PolyVault/hello.txt",
  "size": 123,
  "destination": { "kind": "gdrive", "name": "gdrive", "...": "…" }
}
```

`GET /health` → `{ "ok": true }`.

## Why not free Cloudflare Workers as the relay?

Workers Free allows only ~**10 ms CPU** per invocation — too little to stream files to Drive. Workers Paid (~$5/mo) can work, but Oracle Always Free is the $0 path.

## Roadmap

- Encryption at rest / before upload
- Dropbox, Mega, WebDAV replicas
- Hardened relay (mTLS, per-user tokens, multipart streaming without buffering)
- Auto-provision R2 + relay docs/scripts

## License

MIT
