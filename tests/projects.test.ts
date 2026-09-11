import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { CliConfigStore } from "../src/config";
import { createProgram } from "../src/program";
import { CliRuntime } from "../src/runtime";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const project = { id: "p1", slug: "web", name: "Web", visibility: "public", access: { canRead: true }, unresolvedIssueCount: 2, entryCount: 3 };
async function fixture(respond?: (path: string, init?: RequestInit) => Response) {
  const directory = await mkdtemp(join(tmpdir(), "approve-cli-projects-"));
  directories.push(directory);
  const store = new CliConfigStore({ APPROVE_CONFIG_DIR: directory });
  store.writeTokens({ access_token: "old", refresh_token: "refresh", token_type: "Bearer", expires_in: 3600 });
  store.writeContext({ version: 1, workspace: { id: "w1", slug: "old-slug", name: "Workspace" }, project: { id: "saved-project", slug: "saved", name: "Saved" } });
  const calls: string[] = [];
  let stdout = "";
  const runtime = new CliRuntime({
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: { write: chunk => { stdout += chunk; } }, stderr: { write() {} },
  }, store, {
    baseUrl: "https://approve.so/api/v1",
    fetcher: (async (input, init) => {
      const path = new URL(String(input)).pathname.replace("/api/v1", "");
      calls.push(path);
      if (respond) return respond(path, init);
      assert.match(path, /^\/workspaces\/[^/]+\/projects$/);
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer old");
      return Response.json({ data: { projects: [project] } });
    }) as typeof fetch,
  });
  const program = createProgram(runtime).exitOverride();
  return { store, calls, stdout: () => stdout, run: (...args: string[]) => program.parseAsync(["node", "approve", "projects", "list", ...args]) };
}

describe("project list request overhead", () => {
  for (const workspace of ["blupp", "workspace-id", "space/key"]) {
    it(`uses one authenticated request for explicit workspace ${workspace}`, async () => {
      const f = await fixture();
      await f.run("--workspace", workspace, "--json");
      assert.deepEqual(f.calls, [`/workspaces/${encodeURIComponent(workspace)}/projects`]);
      assert.deepEqual(JSON.parse(f.stdout()), { data: [project] });
    });
  }

  it("uses the saved workspace ID and preserves table output without resolving the saved project", async () => {
    const f = await fixture();
    await f.run();
    assert.deepEqual(f.calls, ["/workspaces/w1/projects"]);
    assert.match(f.stdout(), /SLUG\s+NAME/);
    assert.match(f.stdout(), /web\s+Web\s+public/);
  });

  it("rejects missing workspace or credentials locally", async () => {
    const f = await fixture();
    f.store.clearContext();
    await assert.rejects(f.run(), /Select a workspace/);
    const other = await fixture();
    other.store.clearCredentials();
    await assert.rejects(other.run("--workspace", "blupp"), /auth login/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(other.calls, []);
  });

  it("refreshes expired credentials and retries the project request directly", async () => {
    const f = await fixture((path, init) => {
      if (path === "/auth/refresh") {
        assert.equal(init?.method, "POST");
        return Response.json({ data: { access_token: "new", refresh_token: "rotated", token_type: "Bearer", expires_in: 3600 } });
      }
      if (new Headers(init?.headers).get("Authorization") === "Bearer old") return Response.json({ error: { message: "Expired" } }, { status: 401 });
      return Response.json({ data: { projects: [project] } });
    });
    await f.run("--workspace", "blupp", "--json");
    assert.deepEqual(f.calls, ["/workspaces/blupp/projects", "/auth/refresh", "/workspaces/blupp/projects"]);
    assert.equal(f.store.readCredentials()?.accessToken, "new");
    assert.deepEqual(JSON.parse(f.stdout()), { data: [project] });
  });

  for (const status of [403, 404]) {
    it(`preserves server access errors (${status}) without extra lookups`, async () => {
      const f = await fixture(() => Response.json({ error: { code: "not_found", message: "Workspace not found." } }, { status }));
      await assert.rejects(f.run("--workspace", "blupp"), /Workspace not found/);
      assert.deepEqual(f.calls, ["/workspaces/blupp/projects"]);
      assert.equal(f.stdout(), "");
      assert.ok(f.store.readCredentials());
    });
  }
});
