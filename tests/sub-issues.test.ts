import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import { ApproveApiClient } from "../src/api-client";
import { createProgram } from "../src/program";
import type { CliRuntime } from "../src/runtime";

function fixture() {
  const calls: Array<{ path: string; body: any }> = [];
  const api = new ApproveApiClient({ baseUrl: "https://approve.so/api/v1", accessToken: "test", fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname + url.search, body });
    return Response.json({ data: { id: "child", projectId: "p1", publicId: "ACME-2", ...body } });
  }) as typeof fetch });
  const stdin = new PassThrough();
  let stdout = "";
  const resolved: string[] = [];
  const runtime = {
    io: { stdin, stdout: { write: (text: string) => { stdout += text; } }, stderr: { write() {} } },
    scope: async () => ({ context: { api }, workspace: { slug: "acme" }, project: { id: "p1" } }),
    resolveIssue: async (_context: unknown, _workspace: unknown, key: string) => { resolved.push(key); return { id: "parent", projectId: "p1" }; },
  } as unknown as CliRuntime;
  const program = createProgram(runtime).exitOverride();
  return { calls, resolved, run: (...args: string[]) => program.parseAsync(["node", "approve", "--json", "issues", "create", "Child", ...args]), output: () => JSON.parse(stdout) };
}

describe("sub-issue CLI creation", () => {
  it("resolves --parent and sends the internal identifier", async () => {
    const f = fixture();
    await f.run("--parent", "ACME-1");
    assert.deepEqual(f.resolved, ["ACME-1"]);
    assert.equal(f.calls[0]!.body.parentIssueId, "parent");
    assert.equal(f.calls[0]!.body.projectId, "p1");
  });
  it("leaves ordinary creation unchanged", async () => {
    const f = fixture();
    await f.run();
    assert.deepEqual(f.resolved, []);
    assert.equal("parentIssueId" in f.calls[0]!.body, false);
  });
});
