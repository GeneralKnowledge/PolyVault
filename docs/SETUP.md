# PolyVault setup guides (sign up for each service)

Target architecture:

```text
laptop ──(once)──► Cloudflare R2 (free hub)
                      │
                      ├── URL-pull ──► OneDrive Personal
                      └── Oracle Always Free relay ──► Google Drive (+ future clouds)
```

Do these in order: **R2 → Oracle relay → Google → Microsoft → wire PolyVault**.

Redirect URI used by the CLI for OAuth (Google + Microsoft):

```text
http://127.0.0.1:8765/callback
```

---

## 1. Cloudflare R2 (free hub)

R2 stores the canonical copy. Free tier includes **10 GB** storage and **free egress**.

### Sign up

1. Open [https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and create a Cloudflare account (email verification).
2. In the dashboard sidebar go to **Storage & databases → R2**.
3. If prompted, enable R2 / agree to the free tier. No Workers Paid plan is required for basic R2 storage.

### Create a bucket

1. On the R2 overview, click **Create bucket**.
2. Name it something like `polyvault` (lowercase, DNS-safe).
3. Leave default location unless you have a preference → **Create bucket**.

### Create S3 API credentials

1. On R2 overview, under Account details, open **Manage** next to **API Tokens** (or **Manage R2 API Tokens**).
2. Click **Create Account API token** (or User API token).
3. Permissions: **Object Read & Write**.
4. Scope: apply to your `polyvault` bucket only (recommended).
5. Create the token.
6. Copy immediately (shown once):
   - **Access Key ID**
   - **Secret Access Key**
   - **Endpoint**: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`  
     (`ACCOUNT_ID` is also on the R2 overview page.)

### Connect PolyVault

```bash
polyvault init

polyvault hub set s3 \
  --name r2 \
  --endpoint https://<ACCOUNT_ID>.r2.cloudflarestorage.com \
  --region auto \
  --bucket polyvault \
  --access-key-id <ACCESS_KEY_ID> \
  --secret-access-key <SECRET_ACCESS_KEY>
```

Official docs: [R2 S3 API](https://developers.cloudflare.com/r2/get-started/s3/), [R2 tokens](https://developers.cloudflare.com/r2/api/tokens/).

---

## 2. Oracle Cloud Always Free (relay VM)

The relay streams **R2 → Google Drive** (and other clouds that cannot URL-pull) so replicas do not transit your laptop.

### Sign up

1. Open [https://www.oracle.com/cloud/free/](https://www.oracle.com/cloud/free/) → **Start for free**.
2. Complete the account form (email, password, country).
3. Choose a **Home Region** carefully — you cannot change it later. Prefer a region with Ampere A1 capacity (e.g. many people use US regions; availability varies).
4. Oracle requires a credit card for identity verification. A small temporary hold may appear; **Always Free resources stay free** if you stay within limits.
5. Set a **budget alert of $0 / $1** in Billing after signup so you get notified if anything billable is created by mistake.

### Create an Always Free VM

Current Always Free Ampere pool (as of 2026): up to **2 OCPUs + 12 GB RAM** total per Always Free tenancy (plus two tiny AMD micros). Stay inside “Always Free-eligible” in the UI.

1. Console → ☰ → **Compute → Instances → Create instance**.
2. Name: `polyvault-relay`.
3. Image: Oracle Linux or Ubuntu (**Always Free-eligible**).
4. Shape → **Change shape → Ampere → `VM.Standard.A1.Flex`**.  
   Example: **1 OCPU / 6 GB** (or use the full free pool on one VM). Confirm the badge says Always Free-eligible.
5. Networking:
   - Public subnet
   - **Assign a public IPv4 address** = ON
6. Add your SSH public key.
7. Create. If you see **Out of capacity**, try another Availability Domain, smaller shape, or retry later.

### Open port 8787

1. Instance details → click the **Virtual Cloud Network** / subnet → **Security List**.
2. **Add Ingress Rules**:
   - Source CIDR: `0.0.0.0/0` (or lock to your home IP)
   - IP protocol: TCP
   - Destination port: `8787`
3. Keep the existing SSH rule on port `22`.
4. On the VM OS firewall as well, e.g. Ubuntu:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 8787/tcp
sudo ufw enable
```

### Install and run the PolyVault relay

SSH in (`ssh ubuntu@PUBLIC_IP` or `opc@PUBLIC_IP` depending on image), then:

```bash
# Install Node 20+
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone https://github.com/GeneralKnowledge/PolyVault.git
cd PolyVault
npm install
npm run build

export RELAY_TOKEN="$(openssl rand -hex 24)"
export PORT=8787
echo "Save this token for your laptop: $RELAY_TOKEN"

# Foreground test
npm run relay:prod

# Or under systemd / tmux for always-on
```

Example systemd unit (`/etc/systemd/system/polyvault-relay.service`):

```ini
[Unit]
Description=PolyVault relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/PolyVault
Environment=PORT=8787
Environment=RELAY_TOKEN=REPLACE_ME
ExecStart=/usr/bin/node dist/relay/main.js
Restart=always
User=ubuntu

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now polyvault-relay
curl http://127.0.0.1:8787/health
```

### Point your laptop at the relay

```bash
polyvault relay set --url http://YOUR_PUBLIC_IP:8787 --token "$RELAY_TOKEN"
```

---

## 3. Google Cloud (Google Drive replica)

Needed so PolyVault (or the relay) can write files into your Drive.

### Sign up / project

1. Open [https://console.cloud.google.com/](https://console.cloud.google.com/) and sign in with the Google account that owns the Drive.
2. Create a project (e.g. `polyvault`) if you do not have one.

### Enable Drive API

1. **APIs & Services → Library**.
2. Search **Google Drive API** → **Enable**.

### OAuth consent screen

1. **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Branding**).
2. User type: **External** (unless you use Google Workspace internal-only).
3. App name: `PolyVault`, support email: yours.
4. Add your Google account as a **test user** while the app is in Testing.
5. Scopes: add `https://www.googleapis.com/auth/drive.file` (files created/opened by the app).

### Create OAuth client

1. **Clients → Create client** (or **Credentials → Create credentials → OAuth client ID**).
2. Application type: **Desktop app** (loopback redirect is supported for desktop clients).
3. If you create a **Web** client instead, add Authorized redirect URI exactly:

   ```text
   http://127.0.0.1:8765/callback
   ```

4. Create → copy **Client ID** and **Client secret**.

### Link in PolyVault

```bash
polyvault provider add gdrive --name gdrive \
  --client-id <CLIENT_ID> \
  --client-secret <CLIENT_SECRET>
```

A browser opens; approve access. Tokens are stored under `~/.polyvault/secrets.json` (mode `0600`).

With R2 hub + Oracle relay configured, `put` uses mode **`relay`** for Drive (hub → VM → Drive).

---

## 4. Microsoft (OneDrive Personal replica)

Needed for OneDrive. With an R2 hub, PolyVault prefers **URL-pull**: Microsoft fetches the file from an R2 signed URL (no relay hop for OneDrive).

### Sign up / register an app

1. Open [https://portal.azure.com/](https://portal.azure.com/) and sign in with your **personal Microsoft account** (Outlook/Hotmail/Live) or work account.
2. Search for **App registrations** → **New registration**.
   - If App registrations is hard to reach with a pure MSA, try [https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade](https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade) or create a free Azure directory when prompted.
3. Name: `PolyVault`.
4. Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
5. Redirect URI:
   - Platform: **Mobile and desktop applications** or **Web**
   - URI: `http://127.0.0.1:8765/callback`
6. Register. Copy **Application (client) ID**.

### Client secret

1. **Certificates & secrets → New client secret**.
2. Add description, choose expiry → **Add**.
3. Copy the **Value** immediately (not the Secret ID).

### API permissions

1. **API permissions → Add a permission → Microsoft Graph → Delegated**.
2. Add:
   - `Files.ReadWrite`
   - `offline_access`
   - `openid`
   - `profile`
3. **Grant admin consent** only if your tenant requires it (personal MSA usually just consents in the browser).

### Link in PolyVault

```bash
polyvault provider add onedrive --name onedrive \
  --client-id <APP_ID> \
  --client-secret <SECRET> \
  --tenant common
```

Approve in the browser. On `put`, expect mode **`onedrive-url-pull`** when the hub is R2.

> Note: Graph **upload from URL** is a **OneDrive Personal** preview feature. Work/school OneDrive may fall back to **relay** or **laptop-bridge**.

---

## Relay fan-out (many destinations)

With a relay configured, one `put` asks the VM to:

1. Download the object **once** from the R2 signed URL  
2. Push in **parallel** to every cloud replica that needs the relay (Drive, Dropbox, WebDAV, extra S3, OneDrive if URL-pull fails)  
3. **Retry** failed pushes (3 attempts)  
4. **Skip** a destination if an object with the same size already exists  

OneDrive Personal still prefers **URL-pull** (Microsoft fetches R2). Cloud replicas without a relay fail unless you pass `--bridge`.

### Extra replicas

```bash
polyvault provider add dropbox --name dropbox --client-id … --client-secret …
polyvault provider add webdav --name nextcloud \
  --base-url https://cloud.example/remote.php/dav/files/alice \
  --username alice --password 'app-password'
polyvault provider add s3 --name b2 …   # another bucket via relay
```

Dropbox: create an app at [https://www.dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) (Scoped access, Full Dropbox), enable `files.content.write` / `files.content.read`, add redirect `http://127.0.0.1:8765/callback`.

WebDAV: use any server that speaks basic PUT/MKCOL (Nextcloud “WebDAV” URL + app password is common).

---

## 5. End-to-end checklist

```bash
polyvault init
polyvault hub set s3 …                 # §1 R2
# deploy relay on Oracle, then:
polyvault relay set --url http://IP:8787 --token …
polyvault provider add gdrive …        # §3
polyvault provider add onedrive …      # §4
polyvault provider add dropbox …       # optional
polyvault provider add webdav …        # optional

echo 'hello from polyvault' > hello.txt
polyvault put hello.txt
polyvault status
```

Expected modes:

| Destination | Mode |
|-------------|------|
| R2 | `hub-upload` |
| OneDrive Personal | `onedrive-url-pull` |
| Google Drive / Dropbox / WebDAV / extra S3 | `relay` (parallel on VM) |
| Already present (same size) | `skipped` |
| Cloud without relay (and no `--bridge`) | fails with SETUP tip |

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| R2 AccessDenied | Token scoped to wrong bucket; recreate Object Read & Write token. |
| Oracle “Out of capacity” | Retry AD / smaller shape / different time; AMD micro VMs are an alternative. |
| Google `redirect_uri_mismatch` | URI must be exactly `http://127.0.0.1:8765/callback`. |
| Google blocked / unverified app | Add yourself as test user on the consent screen. |
| OneDrive URL-pull fails | Personal preview only; set relay so it joins the fan-out batch. |
| Relay 401 | `RELAY_TOKEN` on VM must match `polyvault relay set --token`. |
| Relay can’t reach R2 URL | VM needs outbound HTTPS; security list egress usually open by default. |
| Cloud replica fails without relay | Run Oracle relay + `relay set`, or pass `--bridge` (uses your laptop). |
