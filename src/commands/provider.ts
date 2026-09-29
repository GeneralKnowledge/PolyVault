import { mkdir } from "node:fs/promises";
import open from "open";
import { addProvider, loadConfig } from "../config/store.js";
import type { ProviderKind } from "../config/types.js";
import { linkGoogleDrive, linkOneDrive } from "../providers/index.js";
import { resolveLocalPath } from "../util/path.js";
import { prompt, promptRequired } from "../util/prompt.js";

async function openBrowser(url: string): Promise<void> {
  await open(url);
}

export async function runProviderList(): Promise<void> {
  const config = await loadConfig();
  if (config.providers.length === 0) {
    console.log("No providers configured. Run `polyvault provider add <kind>`.");
    return;
  }

  console.log(`Providers (${config.providers.length}):\n`);
  for (const p of config.providers) {
    switch (p.kind) {
      case "local":
        console.log(`  • ${p.name}  [local]  path=${p.path}`);
        break;
      case "s3":
        console.log(
          `  • ${p.name}  [s3]  bucket=${p.bucket}  endpoint=${p.endpoint}`,
        );
        break;
      case "gdrive":
        console.log(`  • ${p.name}  [gdrive]  clientId=${p.clientId.slice(0, 12)}…`);
        break;
      case "onedrive":
        console.log(
          `  • ${p.name}  [onedrive]  clientId=${p.clientId.slice(0, 12)}…  tenant=${p.tenant ?? "common"}`,
        );
        break;
    }
  }
}

export async function runProviderAdd(
  kind: string,
  flags: {
    name?: string;
    path?: string;
    endpoint?: string;
    region?: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle?: boolean;
    clientId?: string;
    clientSecret?: string;
    tenant?: string;
  },
): Promise<void> {
  const valid: ProviderKind[] = ["local", "s3", "gdrive", "onedrive"];
  if (!valid.includes(kind as ProviderKind)) {
    throw new Error(
      `Unknown provider kind "${kind}". Expected one of: ${valid.join(", ")}`,
    );
  }

  switch (kind as ProviderKind) {
    case "local": {
      const name =
        flags.name ?? (await prompt("Provider name", "local"));
      const pathRaw =
        flags.path ?? (await promptRequired("Local destination directory"));
      const path = resolveLocalPath(pathRaw);
      try {
        await mkdir(path, { recursive: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `Warning: could not create directory "${path}" (${message}). Provider will still be saved; uploads may fail.`,
        );
      }
      await addProvider({ kind: "local", name, path });
      console.log(`Added local provider "${name}" → ${path}`);
      break;
    }
    case "s3": {
      const name = flags.name ?? (await prompt("Provider name", "s3"));
      const endpoint =
        flags.endpoint ??
        (await promptRequired(
          "S3 endpoint URL (e.g. https://<account>.r2.cloudflarestorage.com)",
        ));
      const region =
        flags.region ?? (await prompt("Region", "auto"));
      const bucket =
        flags.bucket ?? (await promptRequired("Bucket name"));
      const accessKeyId =
        flags.accessKeyId ?? (await promptRequired("Access key ID"));
      const secretAccessKey =
        flags.secretAccessKey ?? (await promptRequired("Secret access key"));
      const forcePathStyle = flags.forcePathStyle ?? true;
      await addProvider({
        kind: "s3",
        name,
        endpoint,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle,
      });
      console.log(`Added S3 provider "${name}" → s3://${bucket} @ ${endpoint}`);
      break;
    }
    case "gdrive": {
      const name = flags.name ?? (await prompt("Provider name", "gdrive"));
      const clientId =
        flags.clientId ?? (await promptRequired("Google OAuth client ID"));
      const clientSecret =
        flags.clientSecret ??
        (await promptRequired("Google OAuth client secret"));
      const linked = await linkGoogleDrive({
        name,
        clientId,
        clientSecret,
        openBrowser,
      });
      await addProvider(linked);
      console.log(`Added Google Drive provider "${name}"`);
      break;
    }
    case "onedrive": {
      const name = flags.name ?? (await prompt("Provider name", "onedrive"));
      const clientId =
        flags.clientId ??
        (await promptRequired("Microsoft OAuth application (client) ID"));
      const clientSecret =
        flags.clientSecret ??
        (await promptRequired("Microsoft OAuth client secret"));
      const tenant =
        flags.tenant ?? (await prompt("Tenant", "common"));
      const linked = await linkOneDrive({
        name,
        clientId,
        clientSecret,
        tenant,
        openBrowser,
      });
      await addProvider(linked);
      console.log(`Added OneDrive provider "${name}"`);
      break;
    }
  }
}
