import { getConfigPath, getPolyVaultHome } from "../config/paths.js";
import { initConfig } from "../config/store.js";

export async function runInit(options: { force?: boolean }): Promise<void> {
  const config = await initConfig(options.force ?? false);
  console.log(`Initialized PolyVault at ${getPolyVaultHome()}`);
  console.log(`Config: ${getConfigPath()}`);
  console.log(`Default remote directory: ${config.defaultRemoteDir}`);
  console.log(`
Architecture:
  1. Set a free hub (Cloudflare R2 recommended):
       polyvault hub set s3 --name r2 --endpoint https://<id>.r2.cloudflarestorage.com ...
  2. Add replicas (Drive, OneDrive, local, …):
       polyvault provider add onedrive|gdrive|local|s3
  3. Optional free relay VM (Oracle Always Free) for off-laptop Drive pushes:
       polyvault relay set --url http://YOUR_VM:8787
  4. Upload once:
       polyvault put ./hello.txt
`);
}
