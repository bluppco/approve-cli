import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApproveApiClient, approveApiUrl, DEFAULT_APPROVE_API_URL } from "../src/platform-client";

describe("Approve API transport", () => {
  it("uses the branded production API by default", () => {
    assert.equal(approveApiUrl({}), DEFAULT_APPROVE_API_URL);
    assert.equal(DEFAULT_APPROVE_API_URL, "https://approve.so/api/v1");
  });

  it("allows an HTTPS or local development override", () => {
    assert.equal(approveApiUrl({ APPROVE_API_URL: "https://staging.approve.so/api/v1/" }), "https://staging.approve.so/api/v1");
    assert.equal(approveApiUrl({ APPROVE_API_URL: "http://localhost:4321/api/v1" }), "http://localhost:4321/api/v1");
    assert.throws(() => approveApiUrl({ APPROVE_API_URL: "http://example.com/api/v1" }), /must use HTTPS/);
  });

  it("calls semantic resources on approve.so", async () => {
    let seen: { url: string; authorization: string | null } | undefined;
    const client = new ApproveApiClient({
      accessToken: "access",
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), authorization: new Headers(init?.headers).get("Authorization") };
        return Response.json({ data: [{ id: "workspace-1" }] });
      }) as typeof fetch,
    });

    await client.get("/workspaces");

    assert.deepEqual(seen, { url: "https://approve.so/api/v1/workspaces", authorization: "Bearer access" });
  });

  it("refreshes through approve.so and retries once", async () => {
    const calls: string[] = [];
    const client = new ApproveApiClient({
      accessToken: "expired",
      refreshToken: "refresh-1",
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${new Headers(init?.headers).get("Authorization")}:${url}`);
        if (url.endsWith("/auth/refresh")) return Response.json({ data: { access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 900 } });
        if (calls.length === 1) return Response.json({ error: { code: "unauthenticated", message: "Expired" } }, { status: 401 });
        return Response.json({ data: [] });
      }) as typeof fetch,
    });

    await client.get("/workspaces");

    assert.deepEqual(calls, [
      "Bearer expired:https://approve.so/api/v1/workspaces",
      "Bearer expired:https://approve.so/api/v1/auth/refresh",
      "Bearer access-2:https://approve.so/api/v1/workspaces",
    ]);
  });

  it("starts and redeems browser device authorization through approve.so", async () => {
    const calls: string[] = [];
    const client = new ApproveApiClient({
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? "GET"} ${new Headers(init?.headers).get("Content-Type")} ${init?.body ?? ""} ${url}`);
        if (url.endsWith("/auth/device")) {
          return Response.json({ data: {
            device_code: "ABCD-EFGH.secret",
            user_code: "ABCD-EFGH",
            verification_uri: "https://approve.so/cli/auth",
            verification_uri_complete: "https://approve.so/cli/auth?user_code=ABCD-EFGH",
            expires_in: 600,
            interval: 5,
          } });
        }
        return Response.json({ data: { access_token: "access", refresh_token: "refresh", token_type: "Bearer", expires_in: 900 } });
      }) as typeof fetch,
    });

    const authorization = await client.startDeviceAuthorization();
    const tokens = await client.pollDeviceAuthorization(authorization.device_code);

    assert.equal(authorization.user_code, "ABCD-EFGH");
    assert.equal(tokens.refresh_token, "refresh");
    assert.deepEqual(calls, [
      "POST application/json {} https://approve.so/api/v1/auth/device",
      `POST application/json ${JSON.stringify({ device_code: authorization.device_code })} https://approve.so/api/v1/auth/device/token`,
    ]);
  });

  it("preserves device polling error details", async () => {
    const client = new ApproveApiClient({
      fetcher: (async () => Response.json({
        error: { code: "slow_down", message: "Poll less frequently.", details: { interval: 10 } },
      }, { status: 400 })) as unknown as typeof fetch,
    });

    await assert.rejects(client.pollDeviceAuthorization("ABCD-EFGH.secret"), (caught: unknown) => {
      assert.equal((caught as { code?: string }).code, "slow_down");
      assert.deepEqual((caught as { details?: unknown }).details, { interval: 10 });
      return true;
    });
  });
});

it("uploads large files with bounded chunks and retries a lost response", async () => {
  const size = 8 * 1024 * 1024 + 3;
  const chunks: number[] = [];
  let dropped = false;
  let complete = false;
  const client = new ApproveApiClient({
    accessToken: "access",
    fetcher: (async (input, init) => {
      const url = new URL(String(input));
      const action = url.searchParams.get("upload");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer access");
      if (action === "start") {
        assert.equal(JSON.parse(String(init?.body)).size, size);
        return Response.json({ data: { id: "session" } });
      }
      if (action === "chunk") {
        const chunk = init?.body as Blob;
        chunks.push(chunk.size);
        if (!dropped) { dropped = true; throw new TypeError("lost response"); }
        return Response.json({ data: { offset: Number(url.searchParams.get("offset")) + chunk.size } });
      }
      assert.equal(action, "complete"); complete = true;
      return Response.json({ data: { id: "attachment" } });
    }) as typeof fetch,
  });
  const result = await client.upload("/workspaces/work/issues/issue/attachments", { name: "large.mp4", bytes: new Blob([new Uint8Array(size)]), type: "video/mp4" });
  assert.equal(result.id, "attachment");
  assert.equal(complete, true);
  assert.deepEqual(chunks, [8 * 1024 * 1024, 8 * 1024 * 1024, 3]);
});
