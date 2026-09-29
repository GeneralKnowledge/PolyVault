import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { initConfig, addProvider, loadConfig } from "../src/config/store.js";
import { LocalProvider } from "../src/providers/local.js";
import { runPut } from "../src/commands/put.js";
import { buildRemotePath } from "../src/util/path.js";

describe("buildRemotePath", () => {
  it("joins remote dir and basename", () => {
    assert.equal(buildRemotePath("PolyVault", "/tmp/hello.txt"), "PolyVault/hello.txt");
    assert.equal(buildRemotePath("/PolyVault/", "hello.txt"), "PolyVault/hello.txt");
    assert.equal(buildRemotePath("", "hello.txt"), "hello.txt");
  });
});

describe("LocalProvider", () => {
  it("writes file under root preserving remote path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pv-local-"));
    try {
      const provider = new LocalProvider({
        kind: "local",
        name: "t",
        path: root,
      });
      await provider.putObject({
        remotePath: "PolyVault/hello.txt",
        body: Buffer.from("hi\n"),
        size: 3,
      });
      const content = await readFile(join(root, "PolyVault", "hello.txt"), "utf8");
      assert.equal(content, "hi\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("put fan-out", () => {
  let home: string;
  let destA: string;
  let destB: string;
  let destBad: string;
  let prevHome: string | undefined;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "pv-home-"));
    destA = join(home, "a");
    destB = join(home, "b");
    destBad = join(home, "missing-parent", "nope"); // we'll point at a file-as-dir later
    await mkdir(destA, { recursive: true });
    await mkdir(destB, { recursive: true });
    prevHome = process.env.POLYVAULT_HOME;
    process.env.POLYVAULT_HOME = home;
    await initConfig();
    await addProvider({ kind: "local", name: "local-a", path: destA });
    await addProvider({ kind: "local", name: "local-b", path: destB });
  });

  after(async () => {
    if (prevHome === undefined) delete process.env.POLYVAULT_HOME;
    else process.env.POLYVAULT_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it("uploads to all local providers", async () => {
    const file = join(home, "hello.txt");
    await writeFile(file, "hi\n");
    const outcomes = await runPut(file, {});
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((o) => o.ok));
    assert.equal(
      await readFile(join(destA, "PolyVault", "hello.txt"), "utf8"),
      "hi\n",
    );
    assert.equal(
      await readFile(join(destB, "PolyVault", "hello.txt"), "utf8"),
      "hi\n",
    );
    const cfg = await loadConfig();
    assert.ok(cfg.lastPut);
    assert.equal(cfg.lastPut?.results.length, 2);
  });

  it("isolates failures and continues other providers", async () => {
    // Make destBad a regular file so mkdir of child path fails
    const blocker = join(home, "blocker");
    await writeFile(blocker, "not-a-dir");
    await addProvider({
      kind: "local",
      name: "local-bad",
      path: join(blocker, "child"),
    });

    const file = join(home, "hello2.txt");
    await writeFile(file, "partial\n");
    const outcomes = await runPut(file, {});
    const byName = Object.fromEntries(outcomes.map((o) => [o.name, o]));
    assert.equal(byName["local-a"]?.ok, true);
    assert.equal(byName["local-b"]?.ok, true);
    assert.equal(byName["local-bad"]?.ok, false);
    assert.equal(
      await readFile(join(destA, "PolyVault", "hello2.txt"), "utf8"),
      "partial\n",
    );
    void destBad;
  });
});
