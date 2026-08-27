import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { CliError } from "../src/errors";
import { CliOutput, confirmDestructive, type CliIo } from "../src/io";

function memoryIo(tty = false) {
  let stdout = "";
  let stderr = "";
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = tty;
  const io: CliIo = {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: { isTTY: tty, write: (chunk) => { stdout += chunk; } },
    stderr: { isTTY: tty, write: (chunk) => { stderr += chunk; } },
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

describe("CLI I/O contract", () => {
  it("writes stable JSON envelopes", () => {
    const memory = memoryIo();
    const output = new CliOutput(memory.io, true);
    output.data([{ id: "1" }], { meta: { count: 1 } });
    output.error({ code: "forbidden", message: "No access" });

    assert.deepEqual(JSON.parse(memory.stdout()), { data: [{ id: "1" }], meta: { count: 1 } });
    assert.deepEqual(JSON.parse(memory.stderr()), { error: { code: "forbidden", message: "No access" } });
  });

  it("requires --yes for non-interactive destructive work", async () => {
    const memory = memoryIo(false);
    await assert.rejects(confirmDestructive(memory.io, "Delete?", false), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "confirmation_required");
      assert.equal(error.exitCode, 2);
      return true;
    });
    await confirmDestructive(memory.io, "Delete?", true);
  });
});
