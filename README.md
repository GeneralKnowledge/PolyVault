# PolyVault

Upload a file **once** to a **free Cloudflare R2 hub**. A free-tier relay fills your other free/cheap clouds from the hub:

```text
laptop ──(once)──► R2 hub (free egress)
                      │
                      └── Oracle Always Free relay
                            one hub pull → parallel pushes
                            (Drive, OneDrive, Dropbox, WebDAV, more S3, …)
                            retries + skip-if-same-size
```

```bash
polyvault put ./hello.txt
polyvault put ./hello.txt --dry-run   # plan only
```

**Signup + wire-up for each service:** [docs/SETUP.md](docs/SETUP.md)  
**Related projects / borrowed ideas:** [docs/RELATED.md](docs/RELATED.md)

## Architecture

| Piece | Service | Role |
|--------|---------|------|
| Hub | **Cloudflare R2** | Original lands once (free egress) |
| Fan-out | **Oracle Always Free relay** | One pull → N parallel pushes |
| Local folders | **hub-copy** | Copy/pull from hub; skip if same size |
| Fallback | `--bridge` | Explicit laptop transit for clouds (off by default) |

Core promise: **free-tier services only**, **upload once** from your laptop, **multiple backups** at the end.

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
polyvault provider add gdrive …
polyvault provider add onedrive …
polyvault provider add dropbox …       # optional
polyvault provider add webdav …        # optional
polyvault put hello.txt --dry-run
polyvault put hello.txt
```

## Commands

| Command | Description |
|---------|-------------|
| `hub set s3\|local` | Free hub |
| `provider add <kind>` | `local`, `s3`, `gdrive`, `onedrive`, `dropbox`, `webdav` |
| `relay set --url …` | Free VM that fans out hub → many |
| `put <file>` | Upload once; replicate |
| `put --dry-run` | Show planned hub → replica modes |
| `put --bridge` | Allow laptop-bridge for clouds (debug) |

OAuth redirect: `http://127.0.0.1:8765/callback`

## License

MIT
