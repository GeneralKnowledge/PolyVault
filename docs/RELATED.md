# Related projects (and what we borrow)

PolyVault keeps a narrow promise: **free-tier storage**, **upload once** from your laptop, **many backups** filled from a free R2 hub via a free-tier relay you own.

These projects solve nearby problems. We are not replacing them; we reference them for patterns that are easy to adopt without diluting that promise.

| Project | What it is | What we borrow / why it differs |
|---------|------------|----------------------------------|
| [rclone/rclone](https://github.com/rclone/rclone) | Universal cloud CLI (“rsync for cloud storage”) | Provider coverage inspiration; `--bridge` is our escape hatch when you want laptop-mediated copy (like rclone between remotes). PolyVault is not a full sync engine. |
| [afreidah/s3-orchestrator](https://github.com/afreidah/s3-orchestrator) | S3 endpoint that replicates across R2/B2/OCI/etc. | **Upload-once → N copies**, free-tier stacking mindset, skip/rebalance thinking. Their world is S3-only; we fan out to personal Drive/OneDrive/Dropbox via a user-owned relay. |
| [ozymandiashh/cloudhop](https://github.com/ozymandiashh/cloudhop) | Local MultCloud-style cloud↔cloud GUI (rclone) | Privacy stance: no SaaS middleman. CloudHop typically moves bytes through *your* machine; PolyVault prefers *your free VM* so the laptop uploads once. |
| [xXRoxXeRXx/clumoove](https://github.com/xXRoxXeRXx/clumoove) | Self-hosted multi-cloud migration/sync jobs | Job/replica destination model. Clumoove is a platform for ongoing sync; PolyVault is a `put`-centric backup fan-out. |
| [kinnalru/syncerman](https://github.com/kinnalru/syncerman) | YAML multi-target rclone bisync | **`--dry-run`** before applying changes. |
| [alfisyahry/multisync](https://github.com/alfisyahry/multisync) | Multi-remote backup copy via rclone | Multi-destination backup framing; we keep hub-first so remotes are filled from R2, not from N laptop uploads. |
| [spel987/PolyUploader](https://github.com/spel987/PolyUploader) | Fan-out upload to many anonymous file hosts | Fan-out UX clarity. Different domain (public hosts vs your personal free tiers). |
| [hyperclast/filehub](https://github.com/hyperclast/filehub) | R2 primary + background replication API | Hub-primary + async replicate pattern; FileHub stays R2/local, we add personal clouds through the relay. |

## Ideas already in PolyVault

- **Hub-first write** (R2) — one original upload  
- **Relay fan-out** — one hub pull, parallel pushes, retries, skip-if-same-size  
- **`--dry-run`** — plan modes without uploading  
- **User-owned free tier** — Cloudflare R2 + Oracle Always Free (no MultCloud SaaS)

## Deliberately not doing

- **OneDrive URL-pull** — Microsoft retired Graph “upload from URL” (March 2024). All cloud replicas now go through the relay (or `--bridge`).  
- **Becoming rclone** — no mounts, bisync, or 70+ backends. Thin CLI + free relay is the product.  
- **SaaS middleman** — credentials and bytes stay on infrastructure you control.

## Suggested next borrowings (optional)

1. **Content-hash skip** (beyond same-size) — stronger idempotency like rclone checksums  
2. **Per-replica quotas / free-tier warnings** — s3-orchestrator style soft limits  
3. **Declarative replica profiles** — syncerman YAML for common free-tier stacks  

Keep changes that strengthen “upload once → free multi-backup,” not general-purpose sync.
