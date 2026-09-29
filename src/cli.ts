#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init.js";
import {
  runProviderAdd,
  runProviderList,
  runProviderSetPrimary,
} from "./commands/provider.js";
import { runPut } from "./commands/put.js";
import { runStatus } from "./commands/status.js";

const program = new Command();

program
  .name("polyvault")
  .description(
    "Upload a file once to a primary hub; replicate to other linked clouds.",
  )
  .version("0.1.0");

program
  .command("init")
  .description("Create ~/.polyvault config (or POLYVAULT_HOME)")
  .option("-f, --force", "Overwrite existing config")
  .action(async (opts: { force?: boolean }) => {
    await runInit({ force: opts.force });
  });

const provider = program
  .command("provider")
  .description("Manage cloud providers");

provider
  .command("list")
  .description("List configured providers")
  .action(async () => {
    await runProviderList();
  });

provider
  .command("add")
  .description("Add a provider (local | s3 | gdrive | onedrive)")
  .argument("<kind>", "Provider kind")
  .option("--name <name>", "Provider display name")
  .option("--path <path>", "Local filesystem path (local)")
  .option("--endpoint <url>", "S3-compatible endpoint")
  .option("--region <region>", "S3 region", "auto")
  .option("--bucket <bucket>", "S3 bucket")
  .option("--access-key-id <key>", "S3 access key ID")
  .option("--secret-access-key <secret>", "S3 secret access key")
  .option("--force-path-style", "Use path-style S3 URLs", true)
  .option("--client-id <id>", "OAuth client ID (gdrive/onedrive)")
  .option("--client-secret <secret>", "OAuth client secret")
  .option("--tenant <tenant>", "Microsoft tenant (onedrive)", "common")
  .option("--primary", "Make this provider the upload hub")
  .action(
    async (
      kind: string,
      opts: {
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
        primary?: boolean;
      },
    ) => {
      await runProviderAdd(kind, opts);
    },
  );

provider
  .command("set-primary")
  .description("Choose which provider receives the original upload")
  .argument("<name>", "Provider name")
  .action(async (name: string) => {
    await runProviderSetPrimary(name);
  });

program
  .command("put")
  .description(
    "Upload the original once to the primary hub, then replicate to other providers",
  )
  .argument("<file>", "Local file to upload")
  .option("--to <names>", "Comma-separated provider names")
  .option(
    "--remote-dir <dir>",
    "Remote folder (default: PolyVault from config)",
  )
  .option("--primary <name>", "Override primary hub for this put")
  .action(
    async (
      file: string,
      opts: { to?: string; remoteDir?: string; primary?: string },
    ) => {
      const outcomes = await runPut(file, opts);
      if (outcomes.some((o) => !o.ok)) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("status")
  .description("Show configured providers and last put result")
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
