import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { ApproveApiClient } from "../src/api-client";
import { registerNotificationCommands } from "../src/notifications";
import type { CliRuntime } from "../src/runtime";

function fixture() {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const api = new ApproveApiClient({ baseUrl: "https://approve.so/api/v1", accessToken: "test", fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ data: { notifications: [{ id: "n" }], total: 2, nextCursor: "1" } });
  }) as typeof fetch });
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }; stdin.isTTY = false;
  let stdout = "";
  const scopes: unknown[] = [];
  const runtime = { io: { stdin, stdout: { write: (text: string) => { stdout += text; } }, stderr: { write() {} } },
    scope: async (overrides: unknown, requirements: unknown) => { scopes.push([overrides, requirements]); return { context: { api }, workspace: { slug: "my workspace" } }; },
  } as unknown as CliRuntime;
  const program = new Command().option("--json").option("--yes").option("--workspace <workspace>").exitOverride();
  registerNotificationCommands(program, runtime);
  return { calls, scopes, output: () => JSON.parse(stdout), run: (...args: string[]) => program.parseAsync(["node", "approve", "--json", "--workspace", "w", ...args]) };
}

test("notification list preserves read filters, pagination, and workspace scope", async () => {
  const f = fixture(); await f.run("notifications", "list", "--state", "unread", "--limit", "1", "--cursor", "1");
  assert.equal(f.calls[0]!.path, "/api/v1/workspaces/my%20workspace/notifications?state=unread&limit=1&cursor=1");
  assert.equal(f.output().data.nextCursor, "1");
  assert.deepEqual(f.scopes, [[{ workspace: "w" }, { project: "none" }]]);
  const invalid = fixture(); await assert.rejects(invalid.run("notifications", "list", "--limit", "201"), /Limit/);
  assert.deepEqual(invalid.calls, []);
});

test("notification read commands use explicit boolean state and all-read action", async () => {
  for (const unread of [false, true]) {
    const f = fixture(); await f.run("notifications", "read", "n/1", ...(unread ? ["--unread"] : []));
    assert.equal(f.calls[0]!.path, "/api/v1/workspaces/my%20workspace/notifications/n%2F1");
    assert.equal(f.calls[0]!.method, "PATCH"); assert.deepEqual(f.calls[0]!.body, { read: !unread });
  }
  const f = fixture(); await f.run("notifications", "read-all");
  assert.deepEqual(f.calls[0]!.body, { action: "mark-all-read" });
});

test("individual and bulk notification deletion require confirmation", async () => {
  for (const args of [["delete", "n/1"], ["delete-all"], ["delete-all", "--read"]]) {
    const denied = fixture(); await assert.rejects(denied.run("notifications", ...args), /--yes/);
    assert.deepEqual(denied.calls, []);
    const f = fixture(); await f.run("--yes", "notifications", ...args);
    assert.equal(f.calls[0]!.method, "DELETE");
    assert.equal(f.output().data, null);
    assert.equal(f.calls[0]!.path, `/api/v1/workspaces/my%20workspace/notifications${args[0] === "delete" ? "/n%2F1" : `?mode=${args.includes("--read") ? "read" : "all"}`}`);
  }
});
