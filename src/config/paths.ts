import { homedir } from "node:os";
import { join } from "node:path";

export function getPolyVaultHome(): string {
  const override = process.env.POLYVAULT_HOME;
  if (override && override.trim().length > 0) {
    return override.trim();
  }
  return join(homedir(), ".polyvault");
}

export function getConfigPath(): string {
  return join(getPolyVaultHome(), "config.json");
}

export function getSecretsPath(): string {
  return join(getPolyVaultHome(), "secrets.json");
}
