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
import { openBrowser } from "./browser.js";

export type ScopeOverrides = { workspace?: string; project?: string };
export type ResolvedScope = { context: ApproveContext; workspace: ApiRecord; project?: ApiRecord };
type RuntimeOptions = {
  openBrowser?: (url: string) => Promise<boolean>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  fetcher?: typeof fetch;
  baseUrl?: string;
};

function matches(value: string, ...candidates: Array<string | number | null | undefined>) {
  const normalized = value.toLowerCase();
  return candidates.some((candidate) => candidate != null && String(candidate).toLowerCase() === normalized);
}

function selection(value: ApiRecord): StoredSelection {
  return { id: String(value.id), slug: value.slug, name: value.name };
}

function authTokens(credentials: NonNullable<ReturnType<CliConfigStore["readCredentials"]>>): AuthTokens {
  return {
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    token_type: credentials.tokenType,
    expires_in: credentials.expiresIn,
    ...(credentials.user ? { user: credentials.user } : {}),
  };
}

export class CliRuntime {
  private apiValue: ApproveApiClient | null = null;
  private contextValue: ApproveContext | null = null;

  constructor(
    readonly io: CliIo,
    readonly store = new CliConfigStore(),
    private readonly options: RuntimeOptions = {},
  ) {}

  private client(accessToken?: string, refreshToken?: string, coordinateRefresh = true) {
    return new ApproveApiClient({
      accessToken,
      refreshToken,
      fetcher: this.options.fetcher,
      baseUrl: this.options.baseUrl,
      onTokens: (tokens) => this.persistTokens(tokens),
      ...(coordinateRefresh
        ? { coordinateRefresh: (current, performRefresh) => this.store.withCredentialLock(async () => {
          const stored = this.store.readCredentials();
          if (!stored) throw new CliError("Run `approve auth login` first.", "unauthenticated", 3);
          if (stored.accessToken !== current.accessToken || stored.refreshToken !== current.refreshToken) {
            return authTokens(stored);
          }
          try {
            const tokens = await performRefresh(current.refreshToken);
            this.store.writeTokens(tokens);
            return tokens;
          } catch (error) {
            const rechecked = this.store.readCredentials();
            if (rechecked && (rechecked.accessToken !== current.accessToken || rechecked.refreshToken !== current.refreshToken)) {
              return authTokens(rechecked);
            }
            if (error instanceof CliError && error.exitCode === 3) this.store.clearCredentials();
            throw error;
          }
        }) }
        : {}),
    });
  }

  async login(options: { browser?: boolean } = {}) {
    const api = this.client();
    const authorization = await api.startDeviceAuthorization();
    const browserUrl = authorization.verification_uri_complete ?? authorization.verification_uri;
    this.io.stderr.write(`Open ${authorization.verification_uri}\nCode: ${authorization.user_code}\n`);
    if (options.browser !== false) {
      const opened = await (this.options.openBrowser ?? openBrowser)(browserUrl);
      if (!opened) this.io.stderr.write("Could not open a browser automatically. Open the URL above manually.\n");
    }

    const now = this.options.now ?? Date.now;
    const sleep = this.options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const deadline = now() + authorization.expires_in * 1000;
    let interval = Math.max(1, authorization.interval || 5);
    let tokens: AuthTokens | null = null;
    while (now() < deadline) {
      await sleep(interval * 1000);
      try {
        tokens = await api.pollDeviceAuthorization(authorization.device_code);
        break;
      } catch (caught) {
        if (!(caught instanceof CliError)) throw caught;
        if (caught.code === "authorization_pending") continue;
        if (caught.code === "slow_down") {
          const requested = Number(caught.details?.interval);
          interval = Number.isFinite(requested) && requested > interval ? requested : interval + 5;
          continue;
        }
        if (caught.code === "expired_token") throw new CliError("The browser sign-in expired. Run `approve auth login` again.", "expired_token", 3);
        throw caught;
      }
    }
    if (!tokens) throw new CliError("The browser sign-in expired. Run `approve auth login` again.", "expired_token", 3);
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
    const selected = this.store.readContext();
    const handles = selected.workspace
      ? await context.api.get<Array<{ workspace: { id: string; slug: string }; handle: string }>>("/account/handles")
      : [];
    const handle = handles.find((row) => row.workspace.id === selected.workspace?.id)?.handle ?? null;
    const profile: ApiRecord = { ...context.profile, handle };
    return { user: credentials?.user ?? { id: context.profile.id, email: context.profile.email }, profile, context: selected };
  }

  async logout() {
    await this.store.withCredentialLock(async () => {
      const credentials = this.store.readCredentials();
      if (credentials) await this.client(credentials.accessToken, credentials.refreshToken, false).logout();
      this.store.clearCredentials();
    });
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
