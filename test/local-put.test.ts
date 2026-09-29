import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  addReplica,
  initConfig,
  loadConfig,
  setHub,
  setRelay,
} from "../src/config/store.js";
import { LocalProvider } from "../src/providers/local.js";
import { runPut } from "../src/commands/put.js";
import { buildRemotePath } from "../src/util/path.js";
import { createProvider } from "../src/providers/index.js";
import { withRetry } from "../src/util/retry.js";

describe("buildRemotePath", () => {
  it("joins remote dir and basename", () => {
    assert.equal(
      buildRemotePath("PolyVault", "/tmp/hello.txt"),
      "PolyVault/hello.txt",
    );
  });
});

describe("withRetry", () => {
  it("retries then succeeds", async () => {
    let n = 0;
    const v = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new Error("fail");
        return "ok";
      },
      { attempts: 3, delayMs: 1 },
    );
    assert.equal(v, "ok");
    assert.equal(n, 3);
  });
});

describe("LocalProvider", () => {
  it("round-trips put/get/head", async () => {
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
      const got = await provider.getObject("PolyVault/hello.txt");
      assert.equal(got.body.toString("utf8"), "hi\n");
      const head = await provider.headObject("PolyVault/hello.txt");
      assert.equal(head?.size, 3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("hub upload-once + replicate", () => {
  let home: string;
  let hubPath: string;
  let replicaPath: string;
  let prevHome: string | undefined;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "pv-home-"));
    hubPath = join(home, "hub");
    replicaPath = join(home, "replica");
    await mkdir(hubPath, { recursive: true });
    await mkdir(replicaPath, { recursive: true });
    prevHome = process.env.POLYVAULT_HOME;
    process.env.POLYVAULT_HOME = home;
    await initConfig();
    await setHub({ kind: "local", name: "hub", path: hubPath });
    await addReplica({ kind: "local", name: "replica", path: replicaPath });
  });

  after(async () => {
    if (prevHome === undefined) delete process.env.POLYVAULT_HOME;
    else process.env.POLYVAULT_HOME = prevHome;
    await rm(home, { recursive: true, force: true });
  });

  it("uploads original only to hub, then hub-copies to replica", async () => {
    assert.notEqual(await realpath(hubPath), await realpath(replicaPath));

    const file = join(home, "hello.txt");
    const payload = `once-${Date.now()}\n`;
    await writeFile(file, payload);

    const outcomes = await runPut(file, {});
    assert.equal(outcomes.length, 2);
    const hub = outcomes.find((o) => o.role === "hub");
    const replica = outcomes.find((o) => o.role === "replica");
    assert.equal(hub?.ok, true);
    assert.equal(hub?.mode, "hub-upload");
    assert.equal(replica?.ok, true);
    assert.equal(replica?.mode, "hub-copy");

    assert.equal(
      await readFile(join(hubPath, "PolyVault", "hello.txt"), "utf8"),
      payload,
    );
    assert.equal(
      await readFile(join(replicaPath, "PolyVault", "hello.txt"), "utf8"),
      payload,
    );
  });

  it("skips replica when same size already present", async () => {
    const file = join(home, "skipme.txt");
    await writeFile(file, "SAME\n");
    await runPut(file, {});
    const second = await runPut(file, {});
    const replica = second.find((o) => o.name === "replica");
    assert.equal(replica?.ok, true);
    assert.equal(replica?.mode, "skipped");
  });

  it("isolates replica failures after hub success", async () => {
    const blocker = join(home, "blocker");
    await writeFile(blocker, "not-a-dir");
    await addReplica({
      kind: "local",
      name: "bad",
      path: join(blocker, "child"),
    });

    const file = join(home, "hello2.txt");
    await writeFile(file, "partial\n");
    const outcomes = await runPut(file, {});
    const byName = Object.fromEntries(outcomes.map((o) => [o.name, o]));
    assert.equal(byName.hub?.ok, true);
    assert.equal(byName.replica?.ok, true);
    assert.equal(byName.bad?.ok, false);
  });
});

describe("relay multi-destination fan-out", () => {
  it("pulls hub bytes once and writes many local destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "pv-relay-multi-"));
    const destA = join(root, "a");
    const destB = join(root, "b");
    await mkdir(destA, { recursive: true });
    await mkdir(destB, { recursive: true });
    const payload = Buffer.from("fanout\n");

    const sourceServer = createServer(
      (_req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, { "Content-Length": payload.length });
        res.end(payload);
      },
    );
    await new Promise<void>((r) => sourceServer.listen(0, "127.0.0.1", r));
    const sourcePort = (sourceServer.address() as AddressInfo).port;

    try {
      const pull = await fetch(`http://127.0.0.1:${sourcePort}/obj`);
      const buffer = Buffer.from(await pull.arrayBuffer());
      await Promise.all(
        [
          { kind: "local" as const, name: "a", path: destA },
          { kind: "local" as const, name: "b", path: destB },
        ].map(async (cfg) => {
          const p = createProvider(cfg);
          return p.putObject({
            remotePath: "PolyVault/x.txt",
            body: buffer,
            size: buffer.length,
          });
        }),
      );

      assert.equal(
        await readFile(join(destA, "PolyVault", "x.txt"), "utf8"),
        "fanout\n",
      );
      assert.equal(
        await readFile(join(destB, "PolyVault", "x.txt"), "utf8"),
        "fanout\n",
      );
    } finally {
      sourceServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores relay URL via config", async () => {
    const home = await mkdtemp(join(tmpdir(), "pv-relay-cfg-"));
    const prev = process.env.POLYVAULT_HOME;
    try {
      process.env.POLYVAULT_HOME = home;
      await initConfig();
      await setRelay({ url: "http://127.0.0.1:8787", token: "secret" });
      const cfg = await loadConfig();
      assert.equal(cfg.relay?.url, "http://127.0.0.1:8787");
      assert.equal(cfg.relay?.token, "secret");
    } finally {
      if (prev === undefined) delete process.env.POLYVAULT_HOME;
      else process.env.POLYVAULT_HOME = prev;
      await rm(home, { recursive: true, force: true });
    }
  });
});
