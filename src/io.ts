import { readFile } from "node:fs/promises";
import { stdin as defaultStdin, stdout as defaultStdout, stderr as defaultStderr } from "node:process";
import { createInterface } from "node:readline/promises";
import { CliError } from "./errors.js";

export type WritableLike = { write(chunk: string): unknown; isTTY?: boolean };
export type ReadableLike = NodeJS.ReadStream;

export type CliIo = {
  stdin: ReadableLike;
  stdout: WritableLike;
  stderr: WritableLike;
};

export const processIo: CliIo = { stdin: defaultStdin, stdout: defaultStdout, stderr: defaultStderr };

function displayValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function table(rows: readonly Record<string, unknown>[]) {
  if (!rows.length) return "No results.\n";
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const widths = keys.map((key) => Math.min(48, Math.max(key.length, ...rows.map((row) => displayValue(row[key]).length))));
  const line = (values: string[]) => values.map((value, index) => value.length > widths[index]! ? `${value.slice(0, Math.max(1, widths[index]! - 1))}…` : value.padEnd(widths[index]!)).join("  ").trimEnd();
  return `${line(keys.map((key) => key.toUpperCase()))}\n${line(widths.map((width) => "─".repeat(width)))}\n${rows.map((row) => line(keys.map((key) => displayValue(row[key])))).join("\n")}\n`;
}

function details(value: Record<string, unknown>) {
  const width = Math.max(0, ...Object.keys(value).map((key) => key.length));
  return `${Object.entries(value).map(([key, item]) => `${key.padEnd(width)}  ${displayValue(item)}`).join("\n")}\n`;
}

export class CliOutput {
  constructor(readonly io: CliIo, readonly json = false) {}

  data(value: unknown, options: { meta?: unknown } = {}) {
    if (this.json) {
      this.io.stdout.write(`${JSON.stringify({ data: value, ...(options.meta === undefined ? {} : { meta: options.meta }) })}\n`);
      return;
    }
    if (Array.isArray(value)) {
      this.io.stdout.write(table(value.map((item) => typeof item === "object" && item !== null ? item as Record<string, unknown> : { value: item })));
    } else if (value && typeof value === "object") {
      this.io.stdout.write(details(value as Record<string, unknown>));
    } else {
      this.io.stdout.write(`${displayValue(value)}\n`);
    }
  }

  warning(message: string) {
    this.io.stderr.write(`Warning: ${message}\n`);
  }

  error(error: { code: string; message: string }) {
    this.io.stderr.write(this.json ? `${JSON.stringify({ error })}\n` : `Error: ${error.message}\n`);
  }
}

async function readLine(io: CliIo, prompt: string) {
  const terminal = Boolean(io.stdin.isTTY && io.stdout.isTTY);
  const reader = createInterface({ input: io.stdin, output: io.stderr as NodeJS.WritableStream, terminal });
  try {
    return await reader.question(prompt);
  } finally {
    reader.close();
  }
}

export async function confirmDestructive(io: CliIo, question: string, yes: boolean) {
  if (yes) return;
  if (!io.stdin.isTTY) throw new CliError("This destructive command requires --yes in non-interactive use.", "confirmation_required", 2);
  const answer = (await readLine(io, `${question} [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new CliError("Cancelled.", "cancelled", 2);
}

export async function textFromOptions(io: CliIo, inline: string | undefined, path: string | undefined, label: string) {
  if (inline !== undefined && path !== undefined) throw new CliError(`Use either --${label} or --${label}-file, not both.`, "invalid_input", 2);
  if (inline !== undefined) return inline;
  if (!path) return undefined;
  if (path !== "-") return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of io.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
