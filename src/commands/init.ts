import { getConfigPath, getPolyVaultHome } from "../config/paths.js";
import { initConfig } from "../config/store.js";

export async function runInit(options: { force?: boolean }): Promise<void> {
  const config = await initConfig(options.force ?? false);
  console.log(`Initialized PolyVault at ${getPolyVaultHome()}`);
  console.log(`Config: ${getConfigPath()}`);
  console.log(`Default remote directory: ${config.defaultRemoteDir}`);
  console.log(`\nNext: polyvault provider add local`);
}
