import { getConfigPath, getPolyVaultHome } from "../config/paths.js";
import { loadConfig } from "../config/store.js";

export async function runStatus(): Promise<void> {
  const config = await loadConfig();
  console.log(`PolyVault home: ${getPolyVaultHome()}`);
  console.log(`Config:         ${getConfigPath()}`);
  console.log(`Default remote: ${config.defaultRemoteDir}`);
  console.log(`Primary hub:    ${config.primaryProvider ?? "(none)"}`);
  console.log(`Providers:      ${config.providers.length}`);

  if (config.providers.length > 0) {
    console.log("");
    for (const p of config.providers) {
      const detail =
        p.kind === "local"
          ? p.path
          : p.kind === "s3"
            ? `${p.bucket} @ ${p.endpoint}`
            : p.kind;
      const hub = p.name === config.primaryProvider ? " ★ primary" : "";
      console.log(`  • ${p.name} [${p.kind}] ${detail}${hub}`);
    }
  }

  if (config.lastPut) {
    const lp = config.lastPut;
    console.log("\nLast put:");
    console.log(`  at:        ${lp.at}`);
    console.log(`  file:      ${lp.file}`);
    console.log(`  remoteDir: ${lp.remoteDir}`);
    console.log(`  primary:   ${lp.primary ?? "?"}`);
    for (const r of lp.results) {
      const role = r.role ? ` (${r.role})` : "";
      if (r.ok) {
        console.log(`  ✓ ${r.name}${role}: ${r.destination ?? r.remotePath}`);
      } else {
        console.log(`  ✗ ${r.name}${role}: ${r.error}`);
      }
    }
  } else {
    console.log("\nNo puts recorded yet.");
  }
}
