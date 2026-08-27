import {
  ApproveApiClient,
  listDepartments,
  listIssueStatuses,
  listIssueLabels,
  listWorkspaceIssues,
  listWorkspaceProjects,
  listWorkspaces,
  loadEntry,
  loadTeam,
  type ApiRecord,
  type ApproveContext,
  type AuthTokens,
} from "./api-client.js";
import { CliConfigStore, type StoredContext, type StoredSelection } from "./config.js";
import { CliError } from "./errors.js";
import type { CliIo } from "./io.js";

export type ScopeOverrides = { workspace?: string; project?: string };
export type ResolvedScope = { context: ApproveContext; workspace: ApiRecord; project?: ApiRecord };

function matches(value: string, ...candidates: Array<string | number | null | undefined>) {
  const normalized = value.toLowerCase();
  return candidates.some((candidate) => candidate != null && String(candidate).toLowerCase() === normalized);
}

function selection(value: ApiRecord): StoredSelection {
  return { id: String(value.id), slug: value.slug, name: value.name };
}

export class CliRuntime {
  private apiValue: ApproveApiClient | null = null;
  private contextValue: ApproveContext | null = null;

  constructor(readonly io: CliIo, readonly store = new CliConfigStore()) {}

  private client(accessToken?: string, refreshToken?: string) {
    return new ApproveApiClient({ accessToken, refreshToken, onTokens: (tokens) => this.persistTokens(tokens) });
  }

  async login(email: string, password: string) {
    const api = this.client();
    const tokens = await api.login(email, password);
    this.store.writeTokens(tokens);
    this.apiValue = api;
    this.contextValue = await this.loadContext(api);
    const workspaces = await listWorkspaces(this.contextValue);
    const current = this.store.readContext();
    if (!current.workspace && workspaces.length === 1) this.store.writeContext({ version: 1, workspace: selection(workspaces[0]!) });
    return { user: tokens.user ?? { id: this.contextValue.profile.id, email: this.contextValue.profile.email }, workspaces };
  }

  async authStatus() {
    const context = await this.authenticated();
    const credentials = this.store.readCredentials();
    return { user: credentials?.user ?? { id: context.profile.id, email: context.profile.email }, profile: context.profile, context: this.store.readContext() };
  }

  async logout() {
    const credentials = this.store.readCredentials();
    if (credentials) await this.client(credentials.accessToken, credentials.refreshToken).logout();
    this.store.clearCredentials();
    this.apiValue = null;
    this.contextValue = null;
  }

  private persistTokens(tokens: AuthTokens | null) {
    if (tokens) this.store.writeTokens(tokens);
    else this.store.clearCredentials();
  }

  private async loadContext(api: ApproveApiClient): Promise<ApproveContext> {
    const me = await api.get<{ profile: ApiRecord }>("/auth/me");
    return { api, db: api, profile: me.profile };
  }

  async authenticated() {
    if (this.contextValue) return this.contextValue;
    const credentials = this.store.readCredentials();
    if (!credentials) throw new CliError("Run `approve auth login` first.", "unauthenticated", 3);
    const api = this.client(credentials.accessToken, credentials.refreshToken);
    this.apiValue = api;
    this.contextValue = await this.loadContext(api);
    return this.contextValue;
  }

  close() {}
  storedContext() { return this.store.readContext(); }
  clearStoredContext() { this.store.clearContext(); }

  async setStoredContext(input: ScopeOverrides) {
    const context = await this.authenticated();
    const current = this.store.readContext();
    const workspace = input.workspace
      ? await this.resolveWorkspace(context, input.workspace)
      : current.workspace ? await this.resolveWorkspace(context, current.workspace.id) : null;
    if (!workspace) throw new CliError("--workspace is required when no workspace context is saved.", "workspace_required", 2);
    const project = input.project ? await this.resolveProject(context, workspace, input.project) : undefined;
    const next: StoredContext = { version: 1, workspace: selection(workspace), ...(project ? { project: selection(project) } : {}) };
    this.store.writeContext(next);
    return next;
  }

  async scope(overrides: ScopeOverrides, options: { project?: "required" | "optional" | "none" } = {}): Promise<ResolvedScope> {
    const context = await this.authenticated();
    const stored = this.store.readContext();
    const workspaceKey = overrides.workspace ?? stored.workspace?.id;
    if (!workspaceKey) throw new CliError("Select a workspace with `approve context set --workspace <slug>` or pass --workspace.", "workspace_required", 2);
    const workspace = await this.resolveWorkspace(context, workspaceKey);
    if (options.project === "none") return { context, workspace };
    const storedProject = stored.workspace?.id === workspace.id ? stored.project?.id : undefined;
    const projectKey = overrides.project ?? storedProject;
    if (!projectKey) {
      if (options.project === "required") throw new CliError("Select a project with `approve context set --workspace <slug> --project <slug>` or pass --project.", "project_required", 2);
      return { context, workspace };
    }
    return { context, workspace, project: await this.resolveProject(context, workspace, projectKey) };
  }

  async resolveWorkspace(context: ApproveContext, key: string): Promise<ApiRecord> {
    const workspaces = await listWorkspaces(context);
    const found = workspaces.find((workspace) => matches(key, workspace.id, workspace.slug));
    if (!found) throw new CliError(`Workspace ${key} was not found or is not accessible.`, "not_found", 5);
    const detail = await context.api.get<ApiRecord>(`/workspaces/${encodeURIComponent(found.slug)}`);
    return { ...detail, role: found.role, isDefault: found.isDefault };
  }

  async resolveProject(context: ApproveContext, workspace: ApiRecord, key: string) {
    const catalog = await listWorkspaceProjects(context.api, workspace.slug);
    const found = catalog.projects.find((project: ApiRecord) => matches(key, project.id, project.slug));
    if (!found || !found.access?.canRead) throw new CliError(`Project ${key} was not found or is not accessible.`, "not_found", 5);
    return found;
  }

  async resolvePerson(context: ApproveContext, workspace: ApiRecord, key: string): Promise<ApiRecord> {
    const normalized = key.replace(/^@/, "").toLowerCase();
    const members = (await loadTeam(context.api, workspace.slug)).members;
    const person = members.find((item: ApiRecord) => matches(normalized, item.id, item.handle, item.email));
    if (!person) throw new CliError(`Workspace member ${key} was not found.`, "not_found", 5);
    return person;
  }

  async resolveDepartment(context: ApproveContext, workspace: ApiRecord, key: string) {
    const departments = await listDepartments(context.api, workspace.slug);
    const found = departments.find((department) => matches(key, department.id, department.name));
    if (!found) throw new CliError(`Department ${key} was not found.`, "not_found", 5);
    return found;
  }

  async resolveStatus(context: ApproveContext, workspace: ApiRecord, key: string, includeArchived = true) {
    const statuses = await listIssueStatuses(context.api, workspace.slug, includeArchived);
    const found = statuses.find((status) => matches(key, status.id, status.name));
    if (!found) throw new CliError(`Status ${key} was not found.`, "not_found", 5);
    return found;
  }

  async resolveIssueLabel(context: ApproveContext, workspace: ApiRecord, key: string, includeArchived = true) {
    const labels = await listIssueLabels(context.api, workspace.slug, includeArchived);
    const found = labels.find((label) => matches(key, label.id, label.name));
    if (!found) throw new CliError(`Issue label ${key} was not found.`, "not_found", 5);
    return found;
  }

  async resolveIssue(context: ApproveContext, workspace: ApiRecord, key: string): Promise<ApiRecord> {
    const detail = await context.api.get<ApiRecord>(`/workspaces/${encodeURIComponent(workspace.slug)}/issues/${encodeURIComponent(key)}`).catch(() => null);
    if (!detail) throw new CliError(`Issue ${key} was not found.`, "not_found", 5);
    return { ...detail, project_id: detail.projectId, issue_number: detail.issueNumber };
  }

  async resolveEntry(context: ApproveContext, workspace: ApiRecord, project: ApiRecord, key: string) {
    const entry = await loadEntry(context.api, workspace.slug, project.id, key).catch(() => null);
    if (!entry) throw new CliError(`Entry ${key} was not found.`, "not_found", 5);
    return entry;
  }

  async team(workspace: ApiRecord) { return loadTeam((await this.authenticated()).api, workspace.slug); }

  async activeIssueCount(context: ApproveContext, workspace: ApiRecord, statusId: string) {
    const result = await listWorkspaceIssues(context.api, workspace.slug);
    return result.issues.filter((issue: ApiRecord) => issue.statusId === statusId).length;
  }
}
