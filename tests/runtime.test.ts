import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { CliConfigStore } from "../src/config";
import type { CliIo } from "../src/io";
import { CliRuntime } from "../src/runtime";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("CLI browser authentication", () => {
  it("opens the approval page, polls, and stores the resulting session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approve-cli-runtime-"));
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
    const opened: string[] = [];
    const sleeps: number[] = [];
    let polls = 0;
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/auth/device")) return Response.json({ data: {
        device_code: "ABCD-EFGH.secret-value-that-is-long-enough-for-the-server",
        user_code: "ABCD-EFGH",
        verification_uri: "https://approve.so/cli/auth",
        verification_uri_complete: "https://approve.so/cli/auth?user_code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      } });
      if (url.endsWith("/auth/device/token")) {
        polls += 1;
        if (polls === 1) return Response.json({ error: { code: "authorization_pending", message: "Waiting" } }, { status: 400 });
        return Response.json({ data: {
          access_token: "access",
          refresh_token: "refresh",
          token_type: "Bearer",
          expires_in: 900,
          user: { id: "user-1", email: "person@example.com" },
        } });
      }
      if (url.endsWith("/auth/me")) return Response.json({ data: { profile: { id: "user-1", email: "person@example.com", name: "Person" } } });
      if (url.endsWith("/workspaces")) return Response.json({ data: [{ id: "workspace-1", slug: "acme", name: "Acme" }] });
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const runtime = new CliRuntime(io, store, {
      fetcher,
      openBrowser: async (url) => { opened.push(url); return true; },
      sleep: async (milliseconds) => { sleeps.push(milliseconds); },
      now: () => 1_000,
    });

    const result = await runtime.login();

    assert.equal(result.user.email, "person@example.com");
    assert.deepEqual(opened, ["https://approve.so/cli/auth?user_code=ABCD-EFGH"]);
    assert.deepEqual(sleeps, [5_000, 5_000]);
    assert.match(stderr, /Open https:\/\/approve\.so\/cli\/auth/);
    assert.match(stderr, /Code: ABCD-EFGH/);
    assert.doesNotMatch(stderr, /password/i);
    assert.equal(stdout, "");
    assert.equal(store.readCredentials()?.refreshToken, "refresh");
    assert.equal(store.readContext().workspace?.slug, "acme");
  });

  it("allows concurrent CLI processes to share one rotated session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approve-cli-runtime-"));
    directories.push(directory);
    const storeOne = new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: directory });
    const storeTwo = new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: directory });
    storeOne.writeTokens({
      access_token: "expired-access",
      refresh_token: "refresh-1",
      token_type: "Bearer",
      expires_in: 900,
    });
    const io = { stdin: new PassThrough() as unknown as NodeJS.ReadStream, stdout: { write: () => {} }, stderr: { write: () => {} } } satisfies CliIo;
    let expiredRequests = 0;
    let refreshRequests = 0;
    let allowRefresh!: () => void;
    const bothProcessesReachedApi = new Promise<void>((resolve) => { allowRefresh = resolve; });
    const refreshedAuthorizations: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("Authorization");
      if (url.endsWith("/auth/me") && authorization === "Bearer expired-access") {
        expiredRequests += 1;
        if (expiredRequests === 2) allowRefresh();
        return Response.json({ error: { code: "unauthenticated", message: "Expired" } }, { status: 401 });
      }
      if (url.endsWith("/auth/refresh")) {
        refreshRequests += 1;
        await bothProcessesReachedApi;
        return Response.json({ data: {
          access_token: "access-2",
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 900,
        } });
      }
      if (url.endsWith("/auth/me")) {
        refreshedAuthorizations.push(authorization ?? "");
        return Response.json({ data: { profile: { id: "user-1", email: "person@example.com" } } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
    const first = new CliRuntime(io, storeOne, { fetcher });
    const second = new CliRuntime(io, storeTwo, { fetcher });

    await Promise.all([first.authenticated(), second.authenticated()]);

    assert.equal(refreshRequests, 1);
    assert.deepEqual(refreshedAuthorizations, ["Bearer access-2", "Bearer access-2"]);
    assert.equal(storeOne.readCredentials()?.accessToken, "access-2");
    assert.equal(storeTwo.readCredentials()?.refreshToken, "refresh-2");
  });

  it("keeps credentials after a transient refresh failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approve-cli-runtime-"));
    directories.push(directory);
    const store = new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: directory });
    store.writeTokens({ access_token: "expired", refresh_token: "refresh", token_type: "Bearer", expires_in: 900 });
    const io = { stdin: new PassThrough() as unknown as NodeJS.ReadStream, stdout: { write: () => {} }, stderr: { write: () => {} } } satisfies CliIo;
    const runtime = new CliRuntime(io, store, {
      fetcher: (async (input: RequestInfo | URL) => String(input).endsWith("/auth/refresh")
        ? Response.json({ error: { code: "unavailable", message: "Try again" } }, { status: 503 })
        : Response.json({ error: { code: "unauthenticated", message: "Expired" } }, { status: 401 })) as typeof fetch,
    });

    await assert.rejects(runtime.authenticated(), (error: unknown) => (error as { exitCode?: number }).exitCode === 1);
    assert.equal(store.readCredentials()?.refreshToken, "refresh");
  });

  it("clears credentials only after a terminal refresh failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approve-cli-runtime-"));
    directories.push(directory);
    const store = new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: directory });
    store.writeTokens({ access_token: "expired", refresh_token: "revoked", token_type: "Bearer", expires_in: 900 });
    const io = { stdin: new PassThrough() as unknown as NodeJS.ReadStream, stdout: { write: () => {} }, stderr: { write: () => {} } } satisfies CliIo;
    const runtime = new CliRuntime(io, store, {
      fetcher: (async (input: RequestInfo | URL) => String(input).endsWith("/auth/refresh")
        ? Response.json({ error: { code: "invalid_token", message: "Revoked" } }, { status: 401 })
        : Response.json({ error: { code: "unauthenticated", message: "Expired" } }, { status: 401 })) as typeof fetch,
    });

    await assert.rejects(runtime.authenticated(), (error: unknown) => (error as { exitCode?: number }).exitCode === 3);
    assert.equal(store.readCredentials(), null);
  });

  it("can refresh an expired session while logging out under the credential lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "approve-cli-runtime-"));
    directories.push(directory);
    const store = new CliConfigStore({ ...process.env, APPROVE_CONFIG_DIR: directory });
    store.writeTokens({ access_token: "expired", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 900 });
    const io = { stdin: new PassThrough() as unknown as NodeJS.ReadStream, stdout: { write: () => {} }, stderr: { write: () => {} } } satisfies CliIo;
    let refreshRequests = 0;
    const runtime = new CliRuntime(io, store, {
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get("Authorization");
        if (url.endsWith("/auth/refresh")) {
          refreshRequests += 1;
          return Response.json({ data: { access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } });
        }
        if (url.endsWith("/auth/logout") && authorization === "Bearer expired") {
          return Response.json({ error: { code: "unauthenticated", message: "Expired" } }, { status: 401 });
        }
        if (url.endsWith("/auth/logout") && authorization === "Bearer access-2") return Response.json({ data: {} });
        throw new Error(`Unexpected URL: ${url}`);
      }) as typeof fetch,
    });

    await runtime.logout();

    assert.equal(refreshRequests, 1);
    assert.equal(store.readCredentials(), null);
  });
});
