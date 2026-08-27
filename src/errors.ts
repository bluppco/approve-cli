export class CliError extends Error {
  constructor(message: string, readonly code: string, readonly exitCode: number) {
    super(message);
    this.name = "CliError";
  }
}

export function normalizeCliError(error: unknown) {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return new CliError(message, "not_found", 5);
  if (/required|choose|must|valid|unknown|at most|between/i.test(message)) return new CliError(message, "invalid_input", 2);
  return new CliError(message, "internal", 1);
}
