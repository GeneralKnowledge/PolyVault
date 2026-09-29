# PolyVault

Upload a file **once** to a **free Cloudflare R2 hub**. Replicas are filled from the hub:

```text
laptop ──(once)──► R2 hub (free)
                      ├── URL-pull ──► OneDrive Personal
                      └── Oracle Always Free relay ──► Drive, Dropbox, WebDAV, more S3, …
                            (one hub pull → many parallel pushes, retries, skip-if-same-size)
```

```bash
polyvault put ./hello.txt
```

**Signup + wire-up for each service:** [docs/SETUP.md](docs/SETUP.md)

## Architecture

| Piece | Service | Role |
|--------|---------|------|
| Hub | **Cloudflare R2** | Original lands once (free egress) |
| OneDrive | **URL-pull** | Microsoft fetches R2 |
| Other clouds | **Oracle Always Free relay** | One pull → N parallel pushes |
| Local folders | **hub-copy** | Copy/pull from hub; skip if same size |
| Fallback | `--bridge` | Explicit laptop transit for clouds (off by default) |

## Install

```bash
npm install && npm run build
```

## Quickstart

See [docs/SETUP.md](docs/SETUP.md), then:

```bash
polyvault init
polyvault hub set s3 …                 # R2
polyvault relay set --url http://VM:8787 --token …
polyvault provider add onedrive …
polyvault provider add gdrive …
polyvault provider add dropbox …       # optional
polyvault provider add webdav …        # optional
polyvault put hello.txt
```

## Commands

| Command | Description |
|---------|-------------|
| `hub set s3\|local` | Free hub |
| `provider add <kind>` | `local`, `s3`, `gdrive`, `onedrive`, `dropbox`, `webdav` |
| `relay set --url …` | Free VM that fans out hub → many |
| `put <file>` | Upload once; replicate |
| `put --bridge` | Allow laptop-bridge for clouds (debug) |

OAuth redirect: `http://127.0.0.1:8765/callback`

## License

MIT
