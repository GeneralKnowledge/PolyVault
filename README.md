# PolyVault

Upload a file **once** to a **free Cloudflare R2 hub**. Replicas are filled from the hub:

```text
laptop ──(once)──► R2 hub (free)
                      ├── URL-pull ──► OneDrive Personal
                      └── Oracle Always Free relay ──► Google Drive (+ more)
```

```bash
polyvault put ./hello.txt
```

**Full signup + wire-up instructions for every service:** [docs/SETUP.md](docs/SETUP.md)

## Architecture (preferred)

| Piece | Service | Why |
|--------|---------|-----|
| Hub | **Cloudflare R2** | Free 10 GB + free egress; original lands here once |
| OneDrive | **URL-pull** | Microsoft fetches from an R2 signed URL (no laptop, no relay) |
| Google Drive (+ future) | **Oracle Always Free relay** | One free VM can push hub → many clouds |
| Fallback | Laptop bridge | Only if relay/URL-pull missing (prints a warning) |

## Install

```bash
npm install
npm run build
npm link   # optional
```

Config: `~/.polyvault/` (`POLYVAULT_HOME` override). Secrets mode `0600`.

## Quickstart (after SETUP.md accounts exist)

```bash
polyvault init

polyvault hub set s3 \
  --name r2 \
  --endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --region auto \
  --bucket polyvault \
  --access-key-id <KEY> \
  --secret-access-key <SECRET>

# On Oracle VM: npm run relay:prod  (see docs/SETUP.md)
polyvault relay set --url http://YOUR_VM_IP:8787 --token <RELAY_TOKEN>

polyvault provider add onedrive --name onedrive \
  --client-id <APP_ID> --client-secret <SECRET> --tenant common

polyvault provider add gdrive --name gdrive \
  --client-id <CLIENT_ID> --client-secret <CLIENT_SECRET>

echo 'hi' > hello.txt
polyvault put hello.txt
polyvault status
```

Expected modes: `hub-upload` (R2), `onedrive-url-pull`, `relay` (Drive).

## Local test (no cloud)

```bash
polyvault init
polyvault hub set local --name hub --path /tmp/pv-hub
polyvault provider add local --name replica --path /tmp/pv-replica
polyvault put hello.txt   # modes: hub-upload + hub-copy
```

## Commands

| Command | Description |
|---------|-------------|
| `polyvault init` | Create config |
| `polyvault hub set s3\|local` | Set hub (R2 recommended) |
| `polyvault provider add <kind>` | Add replica (`local`, `s3`, `gdrive`, `onedrive`) |
| `polyvault provider list` | Hub + replicas + relay |
| `polyvault relay set --url …` | Point at Oracle (or other) relay VM |
| `polyvault relay clear` | Remove relay |
| `polyvault put <file>` | Upload once to hub; replicate |
| `polyvault status` | Show last put modes |

`put` options: `--to`, `--remote-dir`, `--bridge` (force laptop bridge).

OAuth redirect URI (Google + Microsoft):

```text
http://127.0.0.1:8765/callback
```

## Relay

```bash
# on the free VM
RELAY_TOKEN=… PORT=8787 npm run relay:prod
```

`POST /v1/replicate` with bearer token; body includes R2 signed `sourceUrl` + destination credentials. `GET /health` for checks.

## Roadmap

- More replicas (Dropbox, Mega, WebDAV) via the same relay
- Encryption before hub upload
- Hardened relay (mTLS, streaming without full buffer)

## License

MIT
