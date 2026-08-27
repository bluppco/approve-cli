import { LoomupError } from "@loomup/client";

export class CliError extends Error {
  constructor(message: string, readonly code: string, readonly exitCode: number) {
    super(message);
    this.name = "CliError";
  }
}

export function normalizeCliError(error: unknown) {
  if (error instanceof CliError) return error;
  if (error instanceof LoomupError) {
    if (error.status === 401) return new CliError(error.message || "Authentication required.", error.code ?? "unauthenticated", 3);
    if (error.status === 403) return new CliError(error.message || "Permission denied.", error.code ?? "forbidden", 4);
    if (error.status === 404) return new CliError(error.message || "Not found.", error.code ?? "not_found", 5);
    if (error.status === 409) return new CliError(error.message || "The operation conflicted with current data.", error.code ?? "conflict", 6);
    if (error.status === 400 || error.status === 422) return new CliError(error.message, error.code ?? "invalid_input", 2);
    return new CliError(error.message, error.code ?? "loomup_error", 1);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return new CliError(message, "not_found", 5);
  if (/required|choose|must|valid|unknown|at most|between/i.test(message)) return new CliError(message, "invalid_input", 2);
  return new CliError(message, "internal", 1);
}
