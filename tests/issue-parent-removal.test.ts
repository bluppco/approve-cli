import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import { ApproveApiClient } from "../src/api-client";
import { CliError } from "../src/errors";
import { CliOutput } from "../src/io";
import { createProgram } from "../src/program";
import type { CliRuntime } from "../src/runtime";

function fixture(options: { parent?: string | null; getStatus?: number; postStatus?: number; refresh?: boolean; malformedSuccess?: boolean } = {}) {
  const calls: Array<{ path: string; method: string; body: any }> = [];
  let posts = 0;
  let stdout = "";
  const api = new ApproveApiClient({ accessToken: "synthetic", ...(options.refresh ? { refreshToken: "synthetic-refresh" } : {}), fetcher: (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path.endsWith("/auth/refresh")) return Response.json({ data: { access_token: "new", refresh_token: "new-refresh" } });
    if (method === "GET") {
      if (options.getStatus) return Response.json({ error: { code: "get_failed", message: "Child read failed" } }, { status: options.getStatus });
      return Response.json({ data: { id: "child", projectId: "p1", parentIssueId: options.parent === undefined ? "unavailable-parent" : options.parent } });
    }
    posts++;
    if (options.refresh && posts === 1) return Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
    if (options.malformedSuccess) return new Response("{truncated", { status: 200, headers: { "Content-Type": "application/json" } });
    if (options.postStatus) return Response.json({ error: { code: "post_failed", message: "Removal failed" } }, { status: options.postStatus });
    return Response.json({ data: { issue: { id: "child", parent_issue_id: null, title: "Keep content" }, replayed: options.parent === null } });
  }) as typeof fetch });
  const runtime = {
    io: { stdin: new PassThrough(), stdout: { write: (text: string) => { stdout += text; } }, stderr: { write() {} } },
    scope: async () => ({ context: { api }, workspace: { slug: "acme" } }),
    resolveIssue: () => { throw new Error("Do not mask child read errors or resolve the parent"); },
  } as unknown as CliRuntime;
  return { calls, output: () => JSON.parse(stdout), run: (...args: string[]) => createProgram(runtime).exitOverride().parseAsync(["node", "approve", "--json", "issues", "remove-parent", "ACME-2", ...args]) };
}
const tuple = ["--expected-parent-id", "original-parent", "--expected-project-id", "p1", "--operation-id", "stable-operation"];

describe("CLI parent removal", () => {
  it("reads only the child, derives guarded IDs, and needs no destructive confirmation", async () => {
    const f = fixture(); await f.run();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0]!.path, "/api/v1/workspaces/acme/issues/ACME-2");
    assert.deepEqual(f.calls[1]!.body, { expectedParentIssueId: "unavailable-parent", expectedProjectId: "p1", operationId: f.calls[1]!.body.operationId });
    assert.match(f.calls[1]!.body.operationId, /^[\da-f-]{36}$/);
    assert.equal(f.calls[1]!.path, "/api/v1/workspaces/acme/issues/child/parent/remove");
    assert.equal(f.output().data.issue.title, "Keep content");
  });
  it("retains the exact operation payload across session recovery", async () => {
    const f = fixture({ refresh: true }); await f.run();
    const writes = f.calls.filter(call => call.path.endsWith("/parent/remove"));
    assert.equal(writes.length, 2); assert.deepEqual(writes[0]!.body, writes[1]!.body);
  });
  it("allows an exact cross-invocation retry after the child is already detached", async () => {
    const f = fixture({ parent: null }); await f.run(...tuple);
    assert.deepEqual(f.calls[1]!.body, { expectedParentIssueId: "original-parent", expectedProjectId: "p1", operationId: "stable-operation" });
    assert.equal(f.output().data.replayed, true);
  });
  it("rejects incomplete replay tuples and ordinary detached requests before writes", async () => {
    for (const args of [["--operation-id", "stable"], ["--expected-parent-id", "parent", "--expected-project-id", "p1"]]) {
      const f = fixture(); await assert.rejects(f.run(...args), (error: unknown) => error instanceof CliError && error.exitCode === 2); assert.equal(f.calls.length, 0);
    }
    const f = fixture({ parent: null }); await assert.rejects(f.run(), (error: unknown) => error instanceof CliError && error.code === "no_parent"); assert.equal(f.calls.length, 1);
  });
  for (const status of [401, 403, 404, 503]) it(`preserves child GET ${status} without making a write`, async () => {
    const f = fixture({ getStatus: status }); await assert.rejects(f.run(), (error: unknown) => error instanceof CliError && error.code === "get_failed"); assert.equal(f.calls.length, 1);
  });
  it("exposes an exact replay tuple and repeatable command in JSON after uncertain failure", async () => {
    const f = fixture({ postStatus: 503 });
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof CliError);
      const retry = error.details!.retry as any;
      assert.deepEqual({ expectedParentIssueId: retry.expectedParentIssueId, expectedProjectId: retry.expectedProjectId, operationId: retry.operationId }, f.calls[1]!.body);
      assert.match(retry.command, /issues remove-parent 'child'.*--operation-id/);
      let json = "";
      new CliOutput({ stdout: { write() {} }, stderr: { write(text: string) { json += text; } }, stdin: new PassThrough() } as any, true).error({ code: error.code, message: error.message, details: error.details });
      assert.equal(JSON.parse(json).error.details.retry.operationId, retry.operationId);
      return true;
    });
  });
  it("treats a truncated successful mutation as uncertain and replays its original tuple after detach", async () => {
    const options = { malformedSuccess: true, parent: "original-parent" as string | null };
    const f = fixture(options);
    let retry: any;
    await assert.rejects(f.run(), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.details?.invalidSuccessStatus, 200);
      retry = error.details?.retry;
      assert.deepEqual({ expectedParentIssueId: retry.expectedParentIssueId, expectedProjectId: retry.expectedProjectId, operationId: retry.operationId }, f.calls[1]!.body);
      return true;
    });
    options.malformedSuccess = false;
    options.parent = null;
    await f.run("--expected-parent-id", retry.expectedParentIssueId, "--expected-project-id", retry.expectedProjectId, "--operation-id", retry.operationId);
    const writes = f.calls.filter(call => call.path.endsWith("/parent/remove"));
    assert.equal(writes.length, 2);
    assert.deepEqual(writes[1]!.body, writes[0]!.body);
    assert.equal(f.output().data.replayed, true);
  });
  it("preserves stale-parent conflicts without manufacturing a fresh retry", async () => {
    const f = fixture({ postStatus: 409 }); await assert.rejects(f.run(...tuple), (error: unknown) => error instanceof CliError && error.exitCode === 6 && error.details === undefined);
  });
});
