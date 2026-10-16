import { randomUUID } from "node:crypto";
import type { ApiRecord, ApproveApiClient } from "./api-client.js";
import { CliError, normalizeCliError } from "./errors.js";

export type ParentRemovalOptions = { expectedParentId?: string; expectedProjectId?: string; operationId?: string };
type RemovalInput = { expectedParentIssueId: string; expectedProjectId: string; operationId: string };

export function validateParentRemovalOptions(options: ParentRemovalOptions) {
  const values = [options.expectedParentId, options.expectedProjectId, options.operationId];
  if (values.some(value => value !== undefined) && values.some(value => value === undefined)) {
    throw new CliError("Pass --expected-parent-id, --expected-project-id, and --operation-id together for a retry.", "invalid_input", 2);
  }
  if (values.some(value => value !== undefined && (!value.trim() || value.length > 200))) {
    throw new CliError("Parent, project, and operation IDs must contain 1–200 characters.", "invalid_input", 2);
  }
}

const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
function childId(value: unknown, label: string) {
  if (!(typeof value === "string" || typeof value === "number") || !String(value).trim() || String(value).length > 200) {
    throw new CliError(`The child issue has an invalid ${label}.`, "invalid_response", 1);
  }
  return String(value);
}

export async function removeIssueParent(api: ApproveApiClient, workspace: string, issueKey: string, options: ParentRemovalOptions) {
  validateParentRemovalOptions(options);
  // GET the child directly: resolveIssue's legacy catch masks auth/network errors.
  const path = `/workspaces/${encodeURIComponent(workspace)}/issues/${encodeURIComponent(issueKey)}`;
  const child = await api.get<ApiRecord>(path);
  const explicitRetry = options.operationId !== undefined;
  if (!explicitRetry && child.parentIssueId == null) throw new CliError("This issue has no parent to remove.", "no_parent", 6);
  const input: RemovalInput = explicitRetry
    ? { expectedParentIssueId: options.expectedParentId!, expectedProjectId: options.expectedProjectId!, operationId: options.operationId! }
    : { expectedParentIssueId: childId(child.parentIssueId, "parent ID"), expectedProjectId: childId(child.projectId, "project ID"), operationId: randomUUID() };
  const id = childId(child.id, "ID");
  try {
    return await api.post<{ issue: ApiRecord; replayed: boolean }>(`/workspaces/${encodeURIComponent(workspace)}/issues/${encodeURIComponent(id)}/parent/remove`, input);
  } catch (caught) {
    const error = normalizeCliError(caught);
    if (error.exitCode !== 1 && typeof error.details?.invalidSuccessStatus !== "number") throw error;
    const command = `approve --workspace ${quote(workspace)} issues remove-parent ${quote(id)} --expected-parent-id ${quote(input.expectedParentIssueId)} --expected-project-id ${quote(input.expectedProjectId)} --operation-id ${quote(input.operationId)}`;
    throw new CliError(`${error.message} The result is uncertain. Retry the same removal with: ${command}`, error.code, 1, {
      ...error.details, retry: { workspace, issue: id, ...input, command },
    });
  }
}
