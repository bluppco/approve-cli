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
});
