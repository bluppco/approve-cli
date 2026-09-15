import type { Command } from "commander";
import type { ApproveApiClient } from "./api-client.js";
import type { CliRuntime } from "./runtime.js";
import { CliError } from "./errors.js";
import { CliOutput, confirmDestructive } from "./io.js";

type Resource = { id: string; name: string | null; url: string; updatedAt: string };
export const resourcesPath = (workspace: string, project: string) => `/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project)}/resources`;

export async function resolveResource(api: ApproveApiClient, path: string, key: string): Promise<Resource> {
  const matches: Resource[] = [];
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const params = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
    const page = await api.requestEnvelope<Resource[]>(`${path}?${params}`);
    const idMatch = page.data.find((resource) => resource.id === key);
    if (idMatch) return idMatch;
    matches.push(...page.data.filter((resource) => resource.name !== null && resource.name !== "" && resource.name === key));
    cursor = typeof page.meta?.nextCursor === "string" ? page.meta.nextCursor : undefined;
    if (cursor && visited.has(cursor)) throw new CliError("Resource pagination did not advance.", "api_error", 1);
    if (cursor) visited.add(cursor);
  } while (cursor);
  const unique = [...new Map(matches.map((resource) => [resource.id, resource])).values()];
  if (unique.length > 1) throw new CliError(`Multiple resources have that name. Use an ID: ${unique.map((resource) => resource.id).join(", ")}`, "ambiguous_resource", 2);
  if (!unique[0]) throw new CliError("Resource not found.", "not_found", 5);
  return unique[0];
}

export function registerResourceCommands(program: Command, runtime: CliRuntime) {
  const group = program.command("resources").description("Read and edit project link resources (URL and optional name)");
  async function scope(command: Command) {
    const options = command.optsWithGlobals();
    const resolved = await runtime.scope({ workspace: options.workspace, project: options.project }, { project: "required" });
    return { api: resolved.context.api, path: resourcesPath(String(resolved.workspace.slug), String(resolved.project!.id)), output: new CliOutput(runtime.io, Boolean(options.json)), yes: Boolean(options.yes) };
  }
  group.command("list").option("--limit <count>", "page size from 1 to 200", "50").option("--cursor <cursor>", "nextCursor from a previous page").action(async (options: { limit: string; cursor?: string }, command: Command) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CliError("Limit must be between 1 and 200.", "invalid_input", 2);
    const { api, path, output } = await scope(command);
    const page = await api.requestEnvelope<Resource[]>(`${path}?${new URLSearchParams({ limit: String(limit), ...(options.cursor ? { cursor: options.cursor } : {}) })}`);
    output.data(output.json ? page.data : page.data.map(({ id, name, url, updatedAt }) => ({ name: name || url, url, updated: updatedAt, id })), { meta: page.meta });
    if (!output.json && page.meta?.nextCursor) runtime.io.stderr.write(`Next page: approve resources list --cursor '${page.meta.nextCursor}'\n`);
  });
  group.command("show <resource>").description("Get a resource by ID or exact name").action(async (key: string, _options: unknown, command: Command) => {
    const { api, path, output } = await scope(command);
    const resource = await resolveResource(api, path, key);
    output.data(await api.get(`${path}/${encodeURIComponent(resource.id)}`));
  });
  group.command("create <url>").option("--name <name>", "optional display name").action(async (url: string, options: { name?: string }, command: Command) => {
    const { api, path, output } = await scope(command);
    output.data(await api.post(path, { url, ...(options.name === undefined ? {} : { name: options.name }) }));
  });
  group.command("update <resource>").option("--url <url>").option("--name <name>", "display name; use an empty string to clear").action(async (key: string, options: { url?: string; name?: string }, command: Command) => {
    if (options.url === undefined && options.name === undefined) throw new CliError("Provide --url or --name.", "invalid_input", 2);
    const { api, path, output } = await scope(command);
    const resource = await resolveResource(api, path, key);
    output.data(await api.patch(`${path}/${encodeURIComponent(resource.id)}`, { ...(options.url === undefined ? {} : { url: options.url }), ...(options.name === undefined ? {} : { name: options.name }) }));
  });
  group.command("delete <resource>").action(async (key: string, _options: unknown, command: Command) => {
    const { api, path, output, yes } = await scope(command);
    const resource = await resolveResource(api, path, key);
    await confirmDestructive(runtime.io, `Delete resource ${resource.name || resource.url}?`, yes);
    output.data(await api.delete(`${path}/${encodeURIComponent(resource.id)}`));
  });
}
