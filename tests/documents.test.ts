import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Command } from "commander";
import { ApproveApiClient } from "../src/api-client";
import { documentsPath, registerDocumentCommands, resolveDocument } from "../src/documents";
import type { CliRuntime } from "../src/runtime";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

function fixture() {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const row = { id: "d2", title: "Brief", updatedAt: "2026-09-06T00:00:00.000Z" };
  const api = new ApproveApiClient({ baseUrl: "https://approve.so/api/v1", accessToken: "test", fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); const method = init?.method ?? "GET";
    if (method === "DELETE" && new Headers(init?.headers).get("Content-Type") !== "application/json") return new Response("Cross-site DELETE form submissions are forbidden", { status: 403 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname + url.search, method, body });
    if (method !== "GET") return Response.json({ data: { ...row, ...body } });
    if (url.pathname.endsWith("/d2")) return Response.json({ data: { ...row, bodyMarkdown: "# Body" } });
    if (url.searchParams.has("cursor")) return Response.json({ data: [row] });
    return Response.json({ data: [{ ...row, id: "d1", title: "Other" }], meta: { nextCursor: "page-two" } });
  }) as typeof fetch });
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }; stdin.isTTY = false;
  let stdout = ""; let stderr = "";
  const scopes: unknown[] = [];
  const runtime = {
    io: { stdin, stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } } },
    scope: async (overrides: unknown) => { scopes.push(overrides); return { context: { api }, workspace: { slug: "acme" }, project: { id: "p1" } }; },
  } as unknown as CliRuntime;
  const program = new Command().option("--json").option("--yes").option("--workspace <workspace>").option("--project <project>").exitOverride();
  registerDocumentCommands(program, runtime);
  const run = (...args: string[]) => program.parseAsync(["node", "approve", "--json", "--workspace", "acme", "--project", "web", ...args]);
  return { api, row, calls, stdin, run, scopes, output: () => JSON.parse(stdout), stderr: () => stderr };
}

describe("document commands", () => {
  it("preserves list pagination metadata and scoped overrides", async () => {
    const f = fixture(); await f.run("documents", "list", "--limit", "1");
    assert.equal(f.output().meta.nextCursor, "page-two");
    assert.deepEqual(f.scopes, [{ workspace: "acme", project: "web" }]);
    assert.match(f.calls[0]!.path, /\/projects\/p1\/documents\?limit=1$/);
  });
  it("resolves across pages and loads the body only for show", async () => {
    const f = fixture(); await f.run("documents", "show", "Brief");
    assert.equal(f.output().data.bodyMarkdown, "# Body");
    assert.equal(f.calls.length, 3);
    assert.match(f.calls[1]!.path, /cursor=page-two/);
  });
  it("rejects ambiguous titles instead of updating the first page's match", async () => {
    const api = new ApproveApiClient({ fetcher: (async (input: RequestInfo | URL) => Response.json(String(input).includes("cursor=") ? { data: [{ id: "d2", title: "Brief" }] } : { data: [{ id: "d1", title: "Brief" }], meta: { nextCursor: "next" } })) as typeof fetch });
    await assert.rejects(resolveDocument(api, documentsPath("acme", "p1"), "Brief"), /d1, d2/);
    assert.equal((await resolveDocument(api, documentsPath("acme", "p1"), "d2")).id, "d2");
  });
  it("reads Markdown from files and stdin without altering it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approve-documents-")); directories.push(directory);
    const path = join(directory, "body.md"); const body = "# Brief\n\n`literal` $value\n";
    await writeFile(path, body);
    const file = fixture(); await file.run("documents", "create", "Brief", "--body-file", path);
    assert.deepEqual(file.calls[0]!.body, { title: "Brief", bodyMarkdown: body });
    const stdin = fixture(); stdin.stdin.end(body); await stdin.run("documents", "update", "d2", "--body-file", "-");
    assert.deepEqual(stdin.calls.at(-1)!.body, { bodyMarkdown: body });
  });
  it("requires explicit deletion confirmation and permits an empty body", async () => {
    const denied = fixture(); await assert.rejects(denied.run("documents", "delete", "d2"), /--yes/);
    assert.equal(denied.calls.some((call) => call.method === "DELETE"), false);
    const accepted = fixture(); await accepted.run("--yes", "documents", "delete", "d2");
    assert.equal(accepted.calls.at(-1)!.method, "DELETE");
    const empty = fixture(); await empty.run("documents", "update", "d2", "--body", "");
    assert.deepEqual(empty.calls.at(-1)!.body, { bodyMarkdown: "" });
  });
});
