import { getConfigPath, getPolyVaultHome } from "../config/paths.js";
import { initConfig } from "../config/store.js";

export async function runInit(options: { force?: boolean }): Promise<void> {
  const config = await initConfig(options.force ?? false);
  console.log(`Initialized PolyVault at ${getPolyVaultHome()}`);
  console.log(`Config: ${getConfigPath()}`);
  console.log(`Default remote directory: ${config.defaultRemoteDir}`);
  console.log(`
Preferred architecture (see docs/SETUP.md for sign-up steps):
  1. Cloudflare R2 hub     →  polyvault hub set s3 …
  2. Oracle Always Free    →  run relay on the VM, then:
                              polyvault relay set --url http://IP:8787
  3. OneDrive (URL-pull)   →  polyvault provider add onedrive …
  4. Google Drive (relay)  →  polyvault provider add gdrive …
  5. polyvault put ./hello.txt
`);
}
