import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
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
import type { AddressInfo } from "node:net";
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

describe("buildRemotePath", () => {
  it("joins remote dir and basename", () => {
    assert.equal(buildRemotePath("PolyVault", "/tmp/hello.txt"), "PolyVault/hello.txt");
  });
});

describe("LocalProvider", () => {
  it("round-trips put/get", async () => {
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

    const cfg = await loadConfig();
    assert.equal(cfg.hub?.name, "hub");
    assert.equal(cfg.lastPut?.hub, "hub");
  });

  it("keeps hub/replica on VERSION_ONE after source mutates", async () => {
    const file = join(home, "mutate.txt");
    await writeFile(file, "VERSION_ONE\n");
    await runPut(file, {});
    await writeFile(file, "VERSION_TWO\n");
    assert.equal(
      await readFile(join(hubPath, "PolyVault", "mutate.txt"), "utf8"),
      "VERSION_ONE\n",
    );
    assert.equal(
      await readFile(join(replicaPath, "PolyVault", "mutate.txt"), "utf8"),
      "VERSION_ONE\n",
    );
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
    assert.equal(byName.hub?.role, "hub");
    assert.equal(byName.hub?.ok, true);
    assert.equal(byName.replica?.ok, true);
    assert.equal(byName.bad?.ok, false);
  });
});

describe("relay replicates from hub URL", () => {
  it("streams sourceUrl into a local destination provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "pv-relay-"));
    const payload = Buffer.from("relayed-bytes\n");

    const sourceServer = createServer(
      (req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": payload.length,
        });
        res.end(payload);
      },
    );

    await new Promise<void>((resolve) => sourceServer.listen(0, "127.0.0.1", resolve));
    const sourcePort = (sourceServer.address() as AddressInfo).port;
    const sourceUrl = `http://127.0.0.1:${sourcePort}/object`;

    try {
      const dest = createProvider({
        kind: "local",
        name: "out",
        path: root,
      });
      // Simulate what the relay does
      const pull = await fetch(sourceUrl);
      const body = Buffer.from(await pull.arrayBuffer());
      const result = await dest.putObject({
        remotePath: "PolyVault/x.txt",
        body,
        size: body.length,
      });
      assert.equal(await readFile(result.destination, "utf8"), "relayed-bytes\n");
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
