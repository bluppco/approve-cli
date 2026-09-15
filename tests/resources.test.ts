import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { ApproveApiClient } from "../src/api-client";
import { resourcesPath, registerResourceCommands, resolveResource } from "../src/resources";
import type { CliRuntime } from "../src/runtime";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function fixture() {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const row = { id: "d2", name: "Website", url: "https://example.com?a=1#b", updatedAt: "2026-09-06T00:00:00.000Z" };
  const api = new ApproveApiClient({ baseUrl: "https://approve.so/api/v1", accessToken: "test", fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    if (method === "DELETE" && new Headers(init?.headers).get("Content-Type") !== "application/json") return new Response("Cross-site DELETE form submissions are forbidden", { status: 403 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    if (method !== "GET") return Response.json({ data: { ...row, ...body } });
    if (url.pathname.endsWith("/d2")) return Response.json({ data: { ...row, name: "Website" } });
    if (url.searchParams.has("cursor")) return Response.json({ data: [row] });
    return Response.json({ data: [{ ...row, id: "d1", name: "Other" }], meta: { nextCursor: "page-two" } });
  }) as typeof fetch });
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }; stdin.isTTY = false;
  let stdout = ""; let stderr = "";
  const scopes: unknown[] = [];
  const runtime = {
    io: { stdin, stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } } },
    scope: async (overrides: unknown) => { scopes.push(overrides); return { context: { api }, workspace: { slug: "acme" }, project: { id: "p1" } }; },
  } as unknown as CliRuntime;
  const program = new Command().option("--json").option("--yes").option("--workspace <workspace>").option("--project <project>").exitOverride();
  registerResourceCommands(program, runtime);
  const run = (...args: string[]) => program.parseAsync(["node", "approve", "--json", "--workspace", "acme", "--project", "web", ...args]);
  return { api, row, calls, stdin, run, scopes, output: () => JSON.parse(stdout), stderr: () => stderr };
}

describe("resource commands", () => {
  it("preserves pagination metadata and workspace/project overrides", async () => {
    const f = fixture(); await f.run("resources", "list", "--limit", "1");
    assert.equal(f.output().meta.nextCursor, "page-two");
    assert.deepEqual(f.scopes, [{ workspace: "acme", project: "web" }]);
    assert.match(f.calls[0]!.path, /\/projects\/p1\/resources\?limit=1$/);
  });
  it("resolves exact names across pages and returns the full URL", async () => {
    const f = fixture(); await f.run("resources", "show", "Website");
    assert.equal(f.output().data.url, "https://example.com?a=1#b");
    assert.match(f.calls[1]!.path, /cursor=page-two/);
  });
  it("creates links with an optional name and preserves URL syntax", async () => {
    const f = fixture(); await f.run("resources", "create", "https://github.com/team/repo?a=%2F#b", "--name", "Repo");
    assert.deepEqual(f.calls[0]!.body, { url: "https://github.com/team/repo?a=%2F#b", name: "Repo" });
    const unnamed = fixture(); await unnamed.run("resources", "create", "https://example.com");
    assert.deepEqual(unnamed.calls[0]!.body, { url: "https://example.com" });
  });
  it("clears a name without changing the URL", async () => {
    const f = fixture(); await f.run("resources", "update", "d2", "--name", "");
    assert.deepEqual(f.calls.at(-1)!.body, { name: "" });
    await assert.rejects(fixture().run("resources", "update", "d2"), /Provide/);
  });
  it("requires confirmation for deletion and supports --yes", async () => {
    const f = fixture(); await assert.rejects(f.run("resources", "delete", "d2"));
    assert.equal(f.calls.some(call => call.method === "DELETE"), false);
    const confirmed = fixture(); await confirmed.run("--yes", "resources", "delete", "d2");
    assert.equal(confirmed.calls.at(-1)!.method, "DELETE");
  });
  it("rejects ambiguous names and looping cursors", async () => {
    const api = new ApproveApiClient({ fetcher: (async (input: RequestInfo | URL) => {
      const second = String(input).includes("cursor=");
      return Response.json({ data: [{ id: second ? "b" : "a", name: "Website" }], ...(second ? {} : { meta: { nextCursor: "next" } }) });
    }) as typeof fetch });
    await assert.rejects(resolveResource(api, "/resources", "Website"), /a, b/);
    const loop = new ApproveApiClient({ fetcher: (async (_input: RequestInfo | URL) => Response.json({ data: [], meta: { nextCursor: "same" } })) as typeof fetch });
    await assert.rejects(resolveResource(loop, "/resources", "missing"), /did not advance/);
  });
});
