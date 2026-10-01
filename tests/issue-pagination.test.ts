import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { ApproveApiClient } from "../src/api-client";
import { createProgram } from "../src/program";
import type { CliRuntime } from "../src/runtime";

function fixture() {
  const calls: URL[] = [];
  const api = new ApproveApiClient({ baseUrl: "https://approve.so/api/v1", accessToken: "test", fetcher: (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); calls.push(url);
    const next = url.searchParams.get("cursor");
    return Response.json({ data: { issues: [{ id: next ? "old-202" : "old-201", title: "Older matching issue" }], nextCursor: next ? null : "opaque-next" } });
  }) as typeof fetch });
  let stdout = "";
  const runtime = {
    io: { stdin: new PassThrough(), stdout: { write: (text: string) => { stdout += text; } }, stderr: { write() {} } },
    scope: async () => ({ context: { api }, workspace: { slug: "acme" }, project: { slug: "web" } }),
    resolveStatus: async () => ({ id: "started" }), resolvePerson: async () => ({ id: "u2" }),
    resolveIssueLabel: async () => ({ id: "bug" }),
  } as unknown as CliRuntime;
  const program = createProgram(runtime).exitOverride();
  return { calls, run: (...args: string[]) => program.parseAsync(["node", "approve", "--json", "issues", "list", ...args]), output: () => JSON.parse(stdout) };
}

test("issue list resolves names and sends all filters before server pagination", async () => {
  const f = fixture();
  await f.run("--status", "Doing", "--category", "started", "--assignee", "member", "--label", "Bug", "--priority", "high", "--due", "2099-01-02", "--limit", "1");
  assert.deepEqual(Object.fromEntries(f.calls[0].searchParams), { project: "web", label: "bug", status: "started", category: "started", assignee: "u2", priority: "high", due: "2099-01-02", limit: "1" });
  assert.equal(f.output().data[0].id, "old-201");
  assert.equal(f.output().meta.nextCursor, "opaque-next");
  const second = fixture();
  await second.run("--status", "Doing", "--category", "started", "--assignee", "member", "--label", "Bug", "--priority", "high", "--due", "2099-01-02", "--cursor", "opaque-next", "--limit", "1");
  assert.equal(second.calls[0].searchParams.get("cursor"), "opaque-next");
  assert.equal(second.output().data[0].id, "old-202");
  assert.equal(second.output().meta.nextCursor, null);
});

test("issue list rejects page sizes that could discard continuation rows", async () => {
  const f = fixture();
  await assert.rejects(f.run("--limit", "201"), /between 1 and 200/);
  assert.equal(f.calls.length, 0);
});
