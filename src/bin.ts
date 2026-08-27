#!/usr/bin/env node
import { CommanderError } from "commander";
import { CliConfigStore } from "./config.js";
import { normalizeCliError } from "./errors.js";
import { CliOutput, processIo } from "./io.js";
import { createProgram } from "./program.js";
import { CliRuntime } from "./runtime.js";

export async function main(argv = process.argv) {
  const runtime = new CliRuntime(processIo, new CliConfigStore());
  const program = createProgram(runtime);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (caught) {
    if (caught instanceof CommanderError) {
      if (caught.code === "commander.helpDisplayed" || caught.code === "commander.version") return 0;
      return caught.exitCode || 2;
    }
    const error = normalizeCliError(caught);
    const options = program.opts() as { json?: boolean };
    new CliOutput(processIo, Boolean(options.json)).error({ code: error.code, message: error.message });
    return error.exitCode;
  } finally {
    runtime.close();
  }
}

process.exitCode = await main();
