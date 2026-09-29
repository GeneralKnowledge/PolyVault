import { mkdir } from "node:fs/promises";
import open from "open";
import {
  addReplica,
  clearRelay,
  loadConfig,
  setHub,
  setRelay,
} from "../config/store.js";
import type { ProviderKind } from "../config/types.js";
import { linkGoogleDrive, linkOneDrive } from "../providers/index.js";
import { resolveLocalPath } from "../util/path.js";
import { prompt, promptRequired } from "../util/prompt.js";

async function openBrowser(url: string): Promise<void> {
  await open(url);
}

type AddFlags = {
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
};

async function buildProvider(kind: ProviderKind, flags: AddFlags) {
  switch (kind) {
    case "local": {
      const name = flags.name ?? (await prompt("Provider name", "local"));
      const pathRaw =
        flags.path ?? (await promptRequired("Local destination directory"));
      const path = resolveLocalPath(pathRaw);
      try {
        await mkdir(path, { recursive: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `Warning: could not create directory "${path}" (${message}).`,
        );
      }
      return { kind: "local" as const, name, path };
    }
    case "s3": {
      const name = flags.name ?? (await prompt("Provider name", "r2"));
      const endpoint =
        flags.endpoint ??
        (await promptRequired(
          "S3 endpoint URL (e.g. https://<account>.r2.cloudflarestorage.com)",
        ));
      const region = flags.region ?? (await prompt("Region", "auto"));
      const bucket = flags.bucket ?? (await promptRequired("Bucket name"));
      const accessKeyId =
        flags.accessKeyId ?? (await promptRequired("Access key ID"));
      const secretAccessKey =
        flags.secretAccessKey ?? (await promptRequired("Secret access key"));
      return {
        kind: "s3" as const,
        name,
        endpoint,
        region,
        bucket,
        accessKeyId,
        secretAccessKey,
        forcePathStyle: flags.forcePathStyle ?? true,
      };
    }
    case "gdrive": {
      const name = flags.name ?? (await prompt("Provider name", "gdrive"));
      const clientId =
        flags.clientId ?? (await promptRequired("Google OAuth client ID"));
      const clientSecret =
        flags.clientSecret ??
        (await promptRequired("Google OAuth client secret"));
      return linkGoogleDrive({
        name,
        clientId,
        clientSecret,
        openBrowser,
      });
    }
    case "onedrive": {
      const name = flags.name ?? (await prompt("Provider name", "onedrive"));
      const clientId =
        flags.clientId ??
        (await promptRequired("Microsoft OAuth application (client) ID"));
      const clientSecret =
        flags.clientSecret ??
        (await promptRequired("Microsoft OAuth client secret"));
      const tenant = flags.tenant ?? (await prompt("Tenant", "common"));
      return linkOneDrive({
        name,
        clientId,
        clientSecret,
        tenant,
        openBrowser,
      });
    }
  }
}

export async function runHubSet(kind: string, flags: AddFlags): Promise<void> {
  const valid: ProviderKind[] = ["local", "s3"];
  if (!valid.includes(kind as ProviderKind)) {
    throw new Error(
      `Hub kind must be local (tests) or s3/R2 (recommended free hub). Got "${kind}".`,
    );
  }
  if (kind === "s3") {
    console.log(
      "Recommended free hub: Cloudflare R2 (10GB free, free egress).",
    );
  } else {
    console.log(
      "Local hub is for tests only. For real multi-cloud use `polyvault hub set s3`.",
    );
  }
  const provider = await buildProvider(kind as ProviderKind, flags);
  await setHub(provider);
  console.log(`Hub set to "${provider.name}" [${provider.kind}]`);
}

export async function runProviderAdd(
  kind: string,
  flags: AddFlags,
): Promise<void> {
  const valid: ProviderKind[] = ["local", "s3", "gdrive", "onedrive"];
  if (!valid.includes(kind as ProviderKind)) {
    throw new Error(
      `Unknown provider kind "${kind}". Expected one of: ${valid.join(", ")}`,
    );
  }
  const config = await loadConfig();
  if (!config.hub) {
    throw new Error(
      "Set the free hub first: `polyvault hub set s3` (R2) or `hub set local` for tests.",
    );
  }
  const provider = await buildProvider(kind as ProviderKind, flags);
  await addReplica(provider);
  console.log(`Added replica "${provider.name}" [${provider.kind}]`);
  if (provider.kind === "gdrive") {
    console.log(
      "Tip: configure Oracle Always Free relay (`polyvault relay set`) so Drive uses mode=relay (see docs/SETUP.md).",
    );
  }
  if (provider.kind === "onedrive") {
    console.log(
      "Tip: with an R2 hub, OneDrive Personal uses URL-pull (Microsoft fetches from R2). See docs/SETUP.md.",
    );
  }
}

export async function runProviderList(): Promise<void> {
  const config = await loadConfig();
  if (!config.hub && config.replicas.length === 0) {
    console.log("Nothing configured. Start with `polyvault hub set s3`.");
    return;
  }

  if (config.hub) {
    console.log("Hub (receives original once):");
    printOne(config.hub, " ★ hub");
  } else {
    console.log("Hub: (not set)");
  }

  console.log(`\nReplicas (${config.replicas.length}):`);
  if (config.replicas.length === 0) {
    console.log("  (none)");
  } else {
    for (const p of config.replicas) printOne(p, "");
  }

  console.log(
    `\nRelay: ${config.relay?.url ?? "(not set — Oracle Always Free VM recommended)"}`,
  );
}

function printOne(
  p: {
    kind: string;
    name: string;
    path?: string;
    bucket?: string;
    endpoint?: string;
    clientId?: string;
    tenant?: string;
  },
  suffix: string,
): void {
  switch (p.kind) {
    case "local":
      console.log(`  • ${p.name}  [local]  path=${p.path}${suffix}`);
      break;
    case "s3":
      console.log(
        `  • ${p.name}  [s3]  bucket=${p.bucket}  endpoint=${p.endpoint}${suffix}`,
      );
      break;
    case "gdrive":
      console.log(
        `  • ${p.name}  [gdrive]  clientId=${(p.clientId ?? "").slice(0, 12)}…${suffix}`,
      );
      break;
    case "onedrive":
      console.log(
        `  • ${p.name}  [onedrive]  clientId=${(p.clientId ?? "").slice(0, 12)}…  tenant=${p.tenant ?? "common"}${suffix}`,
      );
      break;
  }
}

export async function runRelaySet(options: {
  url: string;
  token?: string;
}): Promise<void> {
  const token =
    options.token ??
    (await promptRequired("Relay shared token (RELAY_TOKEN on the VM)"));
  await setRelay({ url: options.url.replace(/\/+$/, ""), token });
  console.log(`Relay set to ${options.url}`);
  console.log(
    "Puts will ask this relay to stream hub → Drive/OneDrive off your laptop.",
  );
}

export async function runRelayClear(): Promise<void> {
  await clearRelay();
  console.log("Relay cleared.");
}
