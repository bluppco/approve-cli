import type { Command } from "commander";
import type { ApproveApiClient } from "./api-client.js";
import type { CliRuntime } from "./runtime.js";
import { CliError } from "./errors.js";
import { CliOutput, confirmDestructive, textFromOptions } from "./io.js";

type Document = { id: string; title: string; bodyMarkdown?: string; updatedAt: string };
export const documentsPath = (workspace: string, project: string) => `/workspaces/${encodeURIComponent(workspace)}/projects/${encodeURIComponent(project)}/documents`;

export async function resolveDocument(api: ApproveApiClient, path: string, key: string): Promise<Document> {
  const matches: Document[] = [];
  let cursor: string | undefined;
  const visited = new Set<string>();
  do {
    const params = new URLSearchParams({ limit: "200", ...(cursor ? { cursor } : {}) });
    const page = await api.requestEnvelope<Document[]>(`${path}?${params}`);
    const idMatch = page.data.find((document) => document.id === key);
    if (idMatch) return idMatch;
    matches.push(...page.data.filter((document) => document.title === key));
    cursor = typeof page.meta?.nextCursor === "string" ? page.meta.nextCursor : undefined;
    if (cursor && visited.has(cursor)) throw new CliError("Document pagination did not advance.", "api_error", 1);
    if (cursor) visited.add(cursor);
  } while (cursor);
  const unique = [...new Map(matches.map((document) => [document.id, document])).values()];
  if (unique.length > 1) throw new CliError(`Multiple documents have that title. Use an ID: ${unique.map((document) => document.id).join(", ")}`, "ambiguous_document", 2);
  if (!unique[0]) throw new CliError("Document not found.", "not_found", 5);
  return unique[0];
}

export function registerDocumentCommands(program: Command, runtime: CliRuntime) {
  const group = program.command("documents").description("Read and edit internal project documents (title and Markdown body)");
  async function scope(command: Command) {
    const options = command.optsWithGlobals();
    const resolved = await runtime.scope({ workspace: options.workspace, project: options.project }, { project: "required" });
    return { api: resolved.context.api, path: documentsPath(String(resolved.workspace.slug), String(resolved.project!.id)), output: new CliOutput(runtime.io, Boolean(options.json)), yes: Boolean(options.yes) };
  }
  group.command("list").option("--limit <count>", "page size from 1 to 200", "50").option("--cursor <cursor>", "nextCursor from a previous page").action(async (options: { limit: string; cursor?: string }, command: Command) => {
    const limit = Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new CliError("Limit must be between 1 and 200.", "invalid_input", 2);
    const { api, path, output } = await scope(command);
    const page = await api.requestEnvelope<Document[]>(`${path}?${new URLSearchParams({ limit: String(limit), ...(options.cursor ? { cursor: options.cursor } : {}) })}`);
    output.data(output.json ? page.data : page.data.map(({ id, title, updatedAt }) => ({ title, updated: updatedAt, id })), { meta: page.meta });
    if (!output.json && page.meta?.nextCursor) runtime.io.stderr.write(`Next page: approve documents list --cursor '${page.meta.nextCursor}'\n`);
  });
  group.command("show <document>").description("Get a document by ID or exact title").action(async (key: string, _options: unknown, command: Command) => {
    const { api, path, output } = await scope(command);
    const document = await resolveDocument(api, path, key);
    output.data(await api.get(`${path}/${encodeURIComponent(document.id)}`));
  });
  group.command("create <title>").option("--body <markdown>").option("--body-file <path>", "Markdown file, or - for stdin").action(async (title: string, options: { body?: string; bodyFile?: string }, command: Command) => {
    const bodyMarkdown = await textFromOptions(runtime.io, options.body, options.bodyFile, "body") ?? "";
    const { api, path, output } = await scope(command);
    output.data(await api.post(path, { title, bodyMarkdown }));
  });
  group.command("update <document>").option("--title <title>").option("--body <markdown>").option("--body-file <path>", "Markdown file, or - for stdin").action(async (key: string, options: { title?: string; body?: string; bodyFile?: string }, command: Command) => {
    const bodyMarkdown = await textFromOptions(runtime.io, options.body, options.bodyFile, "body");
    if (options.title === undefined && bodyMarkdown === undefined) throw new CliError("Provide --title, --body, or --body-file.", "invalid_input", 2);
    const { api, path, output } = await scope(command);
    const document = await resolveDocument(api, path, key);
    output.data(await api.patch(`${path}/${encodeURIComponent(document.id)}`, { ...(options.title === undefined ? {} : { title: options.title }), ...(bodyMarkdown === undefined ? {} : { bodyMarkdown }) }));
  });
  group.command("delete <document>").action(async (key: string, _options: unknown, command: Command) => {
    const { api, path, output, yes } = await scope(command);
    const document = await resolveDocument(api, path, key);
    await confirmDestructive(runtime.io, `Delete document ${document.title}?`, yes);
    output.data(await api.delete(`${path}/${encodeURIComponent(document.id)}`));
  });
}
