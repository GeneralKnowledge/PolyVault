import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
      const result = await provider.putObject({
        remotePath: "PolyVault/hello.txt",
        body: Buffer.from("hi\n"),
        size: 3,
      });
      const content = await readFile(join(root, "PolyVault", "hello.txt"), "utf8");
      assert.equal(content, "hi\n");
      assert.equal(result.destination, join(root, "PolyVault", "hello.txt"));
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
    destBad = join(home, "missing-parent", "nope");
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

  it("one put fans out to distinct destinations (not the same path twice)", async () => {
    const rootA = await realpath(destA);
    const rootB = await realpath(destB);
    assert.notEqual(rootA, rootB, "test destinations must be different folders");

    const file = join(home, "hello.txt");
    const payload = `unique-${Date.now()}\n`;
    await writeFile(file, payload);

    const outcomes = await runPut(file, {});
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every((o) => o.ok));

    const pathA = join(destA, "PolyVault", "hello.txt");
    const pathB = join(destB, "PolyVault", "hello.txt");
    assert.notEqual(await realpath(pathA), await realpath(pathB));
    assert.equal(await readFile(pathA, "utf8"), payload);
    assert.equal(await readFile(pathB, "utf8"), payload);

    // Each outcome reports a different concrete destination
    const destinations = outcomes.map((o) => o.destination);
    assert.equal(new Set(destinations).size, 2);
    assert.ok(destinations.every((d) => d && (d.includes(rootA) || d.includes(rootB))));

    const cfg = await loadConfig();
    assert.ok(cfg.lastPut);
    assert.equal(cfg.lastPut?.results.length, 2);
    assert.equal(
      new Set(cfg.lastPut?.results.map((r) => r.destination)).size,
      2,
    );
  });

  it("rejects put when two providers share the same destination", async () => {
    const dupHome = await mkdtemp(join(tmpdir(), "pv-dup-"));
    const prev = process.env.POLYVAULT_HOME;
    try {
      process.env.POLYVAULT_HOME = dupHome;
      await initConfig();
      const shared = join(dupHome, "shared");
      await mkdir(shared, { recursive: true });
      await addProvider({ kind: "local", name: "one", path: shared });
      await addProvider({ kind: "local", name: "two", path: shared });
      const file = join(dupHome, "x.txt");
      await writeFile(file, "x\n");
      await assert.rejects(
        () => runPut(file, {}),
        /same destination/,
      );
    } finally {
      if (prev === undefined) delete process.env.POLYVAULT_HOME;
      else process.env.POLYVAULT_HOME = prev;
      await rm(dupHome, { recursive: true, force: true });
      // restore suite home for remaining tests
      process.env.POLYVAULT_HOME = home;
    }
  });

  it("isolates failures and continues other providers", async () => {
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
