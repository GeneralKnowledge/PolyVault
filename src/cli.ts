#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import {
  runHubSet,
  runProviderAdd,
  runProviderList,
  runRelayClear,
  runRelaySet,
} from "./commands/provider.js";
import { runPut } from "./commands/put.js";
import { runStatus } from "./commands/status.js";

const program = new Command();

program
  .name("polyvault")
  .description(
    "Upload once to a free R2/S3 hub; fan out to Drive/OneDrive/Dropbox/etc. via a free-tier relay.",
  )
  .version("0.3.0");

program
  .command("init")
  .description("Create ~/.polyvault config (or POLYVAULT_HOME)")
  .option("-f, --force", "Overwrite existing config")
  .action(async (opts: { force?: boolean }) => {
    await runInit({ force: opts.force });
  });

const hub = program
  .command("hub")
  .description("Configure the free hub that receives the original upload");

hub
  .command("set")
  .description("Set hub to s3/R2 (recommended) or local (tests)")
  .argument("<kind>", "local | s3")
  .option("--name <name>", "Hub name")
  .option("--path <path>", "Local path (local hub)")
  .option("--endpoint <url>", "S3/R2 endpoint")
  .option("--region <region>", "S3 region", "auto")
  .option("--bucket <bucket>", "S3/R2 bucket")
  .option("--access-key-id <key>", "Access key ID")
  .option("--secret-access-key <secret>", "Secret access key")
  .option("--force-path-style", "Path-style S3 URLs", true)
  .action(async (kind: string, opts: Record<string, unknown>) => {
    await runHubSet(kind, opts as never);
  });

const provider = program
  .command("provider")
  .description("Manage replica destinations (filled from the hub)");

provider
  .command("list")
  .description("List hub, replicas, and relay")
  .action(async () => {
    await runProviderList();
  });

provider
  .command("add")
  .description(
    "Add a replica (local | s3 | gdrive | onedrive | dropbox | webdav)",
  )
  .argument("<kind>", "Provider kind")
  .option("--name <name>", "Provider display name")
  .option("--path <path>", "Local filesystem path (local)")
  .option("--endpoint <url>", "S3-compatible endpoint")
  .option("--region <region>", "S3 region", "auto")
  .option("--bucket <bucket>", "S3 bucket")
  .option("--access-key-id <key>", "S3 access key ID")
  .option("--secret-access-key <secret>", "S3 secret access key")
  .option("--force-path-style", "Use path-style S3 URLs", true)
  .option("--client-id <id>", "OAuth client ID / Dropbox app key")
  .option("--client-secret <secret>", "OAuth client secret / Dropbox app secret")
  .option("--tenant <tenant>", "Microsoft tenant (onedrive)", "common")
  .option("--base-url <url>", "WebDAV base URL")
  .option("--username <user>", "WebDAV username")
  .option("--password <pass>", "WebDAV password")
  .action(async (kind: string, opts: Record<string, unknown>) => {
    await runProviderAdd(kind, opts as never);
  });

const relay = program
  .command("relay")
  .description("Optional free-tier relay VM (hub → clouds off-laptop)");

relay
  .command("set")
  .description("Point CLI at your relay (Oracle Always Free recommended)")
  .requiredOption("--url <url>", "Relay base URL, e.g. http://1.2.3.4:8787")
  .option("--token <token>", "Shared bearer token (or prompt)")
  .action(async (opts: { url: string; token?: string }) => {
    await runRelaySet(opts);
  });

relay
  .command("clear")
  .description("Remove relay configuration")
  .action(async () => {
    await runRelayClear();
  });

program
  .command("put")
  .description(
    "Upload original once to hub; replicate to replicas (relay / hub-copy)",
  )
  .argument("<file>", "Local file to upload")
  .option("--to <names>", "Comma-separated replica names")
  .option("--remote-dir <dir>", "Remote folder (default: PolyVault)")
  .option("--bridge", "Force laptop-bridge replication (debug)")
  .option("--dry-run", "Show the hub → replica plan without uploading")
  .action(
    async (
      file: string,
      opts: {
        to?: string;
        remoteDir?: string;
        bridge?: boolean;
        dryRun?: boolean;
      },
    ) => {
      const outcomes = await runPut(file, {
        to: opts.to,
        remoteDir: opts.remoteDir,
        bridge: opts.bridge,
        dryRun: opts.dryRun,
      });
      if (outcomes.some((o) => !o.ok)) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("status")
  .description("Show hub, replicas, relay, and last put")
  .action(async () => {
    await runStatus();
  });

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}

void main();
