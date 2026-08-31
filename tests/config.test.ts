import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { CliConfigStore } from "../src/config";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "approve-cli-config-"));
  directories.push(directory);
  return new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: directory });
}

describe("CLI config storage", () => {
  it("persists tokens without storing a password", async () => {
    const config = await store();
    config.writeTokens({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      token_type: "Bearer",
      expires_in: 900,
    });

    const raw = await readFile(config.credentialsPath, "utf8");
    assert.match(raw, /access-secret/);
    assert.match(raw, /refresh-secret/);
    assert.doesNotMatch(raw, /password/i);
    assert.doesNotMatch(raw, /projectUrl/);
    assert.equal(config.readCredentials()?.version, 2);
    if (process.platform !== "win32") assert.equal((await stat(config.credentialsPath)).mode & 0o777, 0o600);
  });

  it("keeps user context separate from credentials", async () => {
    const config = await store();
    config.writeContext({ version: 1, workspace: { id: "w1", slug: "acme", name: "Acme" }, project: { id: "p1", slug: "web", name: "Web" } });

    assert.deepEqual(config.readContext(), {
      version: 1,
      workspace: { id: "w1", slug: "acme", name: "Acme" },
      project: { id: "p1", slug: "web", name: "Web" },
    });
    assert.equal(config.readCredentials(), null);
    config.clearContext();
    assert.deepEqual(config.readContext(), { version: 1 });
  });

  it("serializes credential operations across store instances", async () => {
    const config = await store();
    const second = new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: config.directory });
    const order: string[] = [];
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = config.withCredentialLock(async () => {
      order.push("first-start");
      markFirstStarted();
      await firstCanFinish;
      order.push("first-end");
    });
    await firstStarted;
    const later = second.withCredentialLock(async () => { order.push("second"); });
    releaseFirst();
    await Promise.all([first, later]);

    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  });
});
