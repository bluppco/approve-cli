import { Option, type Command } from "commander";
import type { CliRuntime } from "./runtime.js";
import { CliError } from "./errors.js";
import { CliOutput, confirmDestructive } from "./io.js";

export function registerNotificationCommands(program: Command, runtime: CliRuntime) {
  const group = program.command("notifications").description("Manage your notification inbox in the selected workspace");
  async function scope(command: Command) {
    const options = command.optsWithGlobals();
    const resolved = await runtime.scope({ workspace: options.workspace }, { project: "none" });
    return { api: resolved.context.api, path: `/workspaces/${encodeURIComponent(resolved.workspace.slug)}/notifications`,
      output: new CliOutput(runtime.io, Boolean(options.json)), yes: Boolean(options.yes) };
  }
  group.command("list")
    .addOption(new Option("--state <state>", "filter by read state").choices(["all", "read", "unread"]).default("all"))
    .option("--limit <count>", "page size from 1 to 200", "50")
    .option("--cursor <cursor>", "nextCursor from a previous page")
    .action(async (options: { state: string; limit: string; cursor?: string }, command: Command) => {
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CliError("Limit must be between 1 and 200.", "invalid_input", 2);
      const { api, path, output } = await scope(command);
      output.data(await api.get(`${path}?${new URLSearchParams({ state: options.state, limit: String(limit), ...(options.cursor ? { cursor: options.cursor } : {}) })}`));
    });
  group.command("read <notification>").option("--unread", "mark unread instead")
    .action(async (id: string, options: { unread?: boolean }, command: Command) => {
      const { api, path, output } = await scope(command);
      output.data(await api.patch(`${path}/${encodeURIComponent(id)}`, { read: !options.unread }));
    });
  group.command("read-all").description("Mark all current notifications in this workspace as read")
    .action(async (_options: unknown, command: Command) => {
      const { api, path, output } = await scope(command);
      output.data(await api.patch(path, { action: "mark-all-read" }));
    });
  group.command("delete <notification>").action(async (id: string, _options: unknown, command: Command) => {
    const { api, path, output, yes } = await scope(command);
    await confirmDestructive(runtime.io, "Delete this notification?", yes);
    output.data(await api.delete(`${path}/${encodeURIComponent(id)}`));
  });
  group.command("delete-all").option("--read", "delete only notifications already read")
    .action(async (options: { read?: boolean }, command: Command) => {
      const { api, path, output, yes } = await scope(command);
      await confirmDestructive(runtime.io, `Delete all ${options.read ? "read " : ""}notifications in this workspace?`, yes);
      output.data(await api.delete(`${path}?mode=${options.read ? "read" : "all"}`));
    });
}
