import { getConfigPath, getPolyVaultHome } from "../config/paths.js";
import { loadConfig } from "../config/store.js";

export async function runStatus(): Promise<void> {
  const config = await loadConfig();
  console.log(`PolyVault home: ${getPolyVaultHome()}`);
  console.log(`Config:         ${getConfigPath()}`);
  console.log(`Default remote: ${config.defaultRemoteDir}`);
  console.log(
    `Hub:            ${config.hub ? `${config.hub.name} [${config.hub.kind}]` : "(not set)"}`,
  );
  console.log(`Replicas:       ${config.replicas.length}`);
  console.log(`Relay:          ${config.relay?.url ?? "(not set)"}`);

  if (config.hub) {
    console.log("");
    console.log("Hub:");
    const p = config.hub;
    const detail =
      p.kind === "local"
        ? p.path
        : p.kind === "s3"
          ? `${p.bucket} @ ${p.endpoint}`
          : p.kind;
    console.log(`  ★ ${p.name} [${p.kind}] ${detail}`);
  }

  if (config.replicas.length > 0) {
    console.log("\nReplicas:");
    for (const p of config.replicas) {
      const detail =
        p.kind === "local"
          ? p.path
          : p.kind === "s3"
            ? `${p.bucket} @ ${p.endpoint}`
            : p.kind;
      console.log(`  • ${p.name} [${p.kind}] ${detail}`);
    }
  }

  if (config.lastPut) {
    const lp = config.lastPut;
    console.log("\nLast put:");
    console.log(`  at:   ${lp.at}`);
    console.log(`  file: ${lp.file}`);
    console.log(`  hub:  ${lp.hub ?? "?"}`);
    for (const r of lp.results) {
      const role = r.role ? ` (${r.role}${r.mode ? `/${r.mode}` : ""})` : "";
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
