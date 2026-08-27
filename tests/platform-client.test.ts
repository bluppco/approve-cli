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
});
