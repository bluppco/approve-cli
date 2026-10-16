import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import { ApproveApiClient, listWorkspaceIssues, type ApiRecord } from "../src/api-client";
import { CliConfigStore } from "../src/config";
import { createProgram } from "../src/program";
import { CliRuntime } from "../src/runtime";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const projects = [
  { id: "p-web", slug: "web", name: "Website", access: { canRead: true } },
  { id: "p-api", slug: "api", name: "Backend", access: { canRead: true } },
  { id: "p-hidden", slug: "hidden", name: "Secret", access: { canRead: false } },
];

async function fixture(catalog: ApiRecord[] = projects) {
  const directory = await mkdtemp(join(tmpdir(), "approve-cli-projects-"));
  directories.push(directory);
  const store = new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: directory });
  store.writeTokens({ access_token: "test", refresh_token: "refresh", token_type: "Bearer", expires_in: 900 });
  store.writeContext({ version: 1, workspace: { id: "w1", slug: "acme", name: "Acme" }, project: { id: "p-web", slug: "web", name: "Website" } });
  const calls: URL[] = [];
  let stdout = "";
  const runtime = new CliRuntime({
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout: { write: (text) => { stdout += text; } }, stderr: { write() {} },
  }, store, { baseUrl: "https://approve.so/api/v1", fetcher: (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const path = url.pathname.replace("/api/v1", "");
    if (path === "/auth/me") return Response.json({ data: { profile: { id: "u1" } } });
    if (path === "/workspaces") return Response.json({ data: [{ id: "w1", slug: "acme" }] });
    if (path === "/workspaces/acme") return Response.json({ data: { id: "w1", slug: "acme" } });
    if (path === "/workspaces/acme/projects") return Response.json({ data: { projects: catalog } });
    if (path === "/workspaces/acme/issue-labels") return Response.json({ data: [{ id: "bug", name: "Bug" }] });
    if (path === "/workspaces/acme/statuses") return Response.json({ data: [{ id: "started", name: "Doing" }] });
    if (path === "/workspaces/acme/members") return Response.json({ data: [{ id: "u2", handle: "member" }] });
    if (["/workspaces/acme/departments", "/workspaces/acme/invitations"].includes(path)) return Response.json({ data: [] });
    if (path === "/workspaces/acme/issues") return Response.json({ data: {
      issues: [{ id: url.searchParams.has("cursor") ? "older" : "first" }],
      nextCursor: url.searchParams.has("cursor") ? null : "opaque-next",
    } });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch });
  return {
    calls, store,
    run: (...args: string[]) => {
      stdout = "";
      return createProgram(runtime).exitOverride().parseAsync(["node", "approve", "--json", ...args]);
    },
    output: () => JSON.parse(stdout),
    issueCalls: () => calls.filter((url) => url.pathname.endsWith("/issues")),
    catalogCalls: () => calls.filter((url) => url.pathname.endsWith("/projects")),
  };
}

test("multi-project issue list resolves one catalog, canonicalizes aliases, and forwards filters with each page", async () => {
  const f = await fixture();
  const filters = ["--status", "Doing", "--category", "started", "--assignee", "@member", "--label", "Bug", "--priority", "high", "--due", "2099-01-02", "--limit", "1"];
  await f.run("issues", "list", "--projects", "Website", "p-api", "web", ...filters);
  assert.equal(f.catalogCalls().length, 1);
  assert.deepEqual([...f.issueCalls()[0].searchParams], [
    ["project", "api"], ["project", "web"], ["label", "bug"], ["status", "started"], ["category", "started"],
    ["assignee", "u2"], ["priority", "high"], ["due", "2099-01-02"], ["limit", "1"],
  ]);
  assert.equal(f.output().meta.nextCursor, "opaque-next");
  await f.run("issues", "list", "--projects", "api", "p-web", "Backend", ...filters, "--cursor", "opaque-next");
  assert.equal(f.catalogCalls().length, 2);
  const second = f.issueCalls()[1];
  assert.deepEqual(second.searchParams.getAll("project"), ["api", "web"]);
  const firstFilters = new URLSearchParams(f.issueCalls()[0].searchParams);
  firstFilters.set("cursor", "opaque-next");
  assert.equal(second.search, `?${firstFilters}`);
  assert.equal(f.output().data[0].id, "older");
  assert.equal(f.output().meta.nextCursor, null);
  assert.equal(f.store.readContext().project?.slug, "web");
});

test("All overrides the saved project without loading its catalog, while defaults and explicit single selection remain supported", async () => {
  const f = await fixture();
  await f.run("issues", "list", "--all-projects");
  assert.deepEqual(f.issueCalls()[0].searchParams.getAll("project"), []);
  assert.equal(f.catalogCalls().length, 0);
  await f.run("issues", "list");
  assert.deepEqual(f.issueCalls()[1].searchParams.getAll("project"), ["web"]);
  await f.run("--project", "api", "issues", "list");
  assert.deepEqual(f.issueCalls()[2].searchParams.getAll("project"), ["api"]);
  assert.equal(f.store.readContext().project?.slug, "web");
  f.store.writeContext({ version: 1, workspace: { id: "w1", slug: "acme", name: "Acme" } });
  await f.run("issues", "list");
  assert.deepEqual(f.issueCalls()[3].searchParams.getAll("project"), []);
});

test("explicit project flags conflict before any authenticated request", async () => {
  const f = await fixture();
  await assert.rejects(f.run("issues", "list", "--projects", "web", "--all-projects"), /cannot be combined/);
  await assert.rejects(f.run("--project", "web", "issues", "list", "--projects", "api"), /cannot be combined with --project/);
  await assert.rejects(f.run("issues", "list", "--all-projects", "--project", "web"), /cannot be combined with --project/);
  assert.equal(f.calls.length, 0);
});

test("missing or unreadable projects reject the entire union before issues are read", async () => {
  for (const key of ["missing", "hidden", "Secret"]) {
    const f = await fixture();
    await assert.rejects(f.run("issues", "list", "--projects", "web", key), (error: any) => error.code === "not_found" && error.exitCode === 5);
    assert.equal(f.catalogCalls().length, 1);
    assert.equal(f.issueCalls().length, 0);
  }
});

test("ambiguous exact names require an ID or slug, which take priority over matching names", async () => {
  const f = await fixture([
    ...projects,
    { id: "p-duplicate", slug: "other", name: "Website", access: { canRead: true } },
    { id: "p-name", slug: "named", name: "web", access: { canRead: true } },
  ]);
  await assert.rejects(f.run("issues", "list", "--projects", "Website"), /ambiguous/);
  assert.equal(f.issueCalls().length, 0);
  await f.run("issues", "list", "--projects", "web", "p-duplicate");
  assert.deepEqual(f.issueCalls()[0].searchParams.getAll("project"), ["other", "web"]);
});

test("API client serializes project unions canonically and rejects conflicting scalar/list options", async () => {
  const urls: URL[] = [];
  const api = new ApproveApiClient({ baseUrl: "https://approve.so/api/v1", accessToken: "test", fetcher: (async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input)));
    return Response.json({ data: { issues: [], nextCursor: null } });
  }) as typeof fetch });
  await listWorkspaceIssues(api, "acme", { projectSlugs: ["web", "api", "web"], cursor: "opaque", limit: 1 });
  assert.deepEqual([...urls[0].searchParams], [["project", "api"], ["project", "web"], ["limit", "1"], ["cursor", "opaque"]]);
  await listWorkspaceIssues(api, "acme", { projectSlugs: [] });
  assert.equal(urls[1].searchParams.has("project"), false);
  assert.throws(() => listWorkspaceIssues(api, "acme", { projectSlug: "web", projectSlugs: ["api"] }), /not both/);
  assert.equal(urls.length, 2);
});
