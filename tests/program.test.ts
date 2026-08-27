import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { CliConfigStore } from "../src/config";
import type { CliIo } from "../src/io";
import { createProgram } from "../src/program";
import { CliRuntime } from "../src/runtime";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "approve-cli-program-"));
  directories.push(directory);
  let stdout = "";
  let stderr = "";
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = false;
  const io: CliIo = {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
  };
  const store = new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: directory });
  const runtime = new CliRuntime(io, store);
  const program = createProgram(runtime);
  program.exitOverride();
  return { program, store, stdout: () => stdout, stderr: () => stderr };
}

describe("CLI program", () => {
  it("exposes every product-level management group", async () => {
    const { program } = await fixture();
    assert.equal(program.version(), "0.1.0");
    const names = program.commands.map((command) => command.name());
    assert.deepEqual(names, [
      "auth", "context", "workspaces", "projects", "project-roles", "statuses", "issue-labels", "departments", "members", "invitations", "issues", "comments", "entries", "labels", "attachments", "images",
    ]);
  });

  it("emits saved context through the JSON contract without authenticating", async () => {
    const { program, store, stdout, stderr } = await fixture();
    store.writeContext({ version: 1, workspace: { id: "w1", slug: "acme", name: "Acme" }, project: { id: "p1", slug: "web", name: "Web" } });

    await program.parseAsync(["node", "approve", "--json", "context", "show"]);

    assert.deepEqual(JSON.parse(stdout()), { data: { version: 1, workspace: { id: "w1", slug: "acme", name: "Acme" }, project: { id: "p1", slug: "web", name: "Web" } } });
    assert.equal(stderr(), "");
  });
});
