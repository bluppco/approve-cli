import { CliError } from "./errors.js";

export const DEFAULT_APPROVE_API_URL = "https://approve.so/api/v1";

export type ApiRecord = Record<string, any>;
export type AuthUser = { id: string; email: string; [key: string]: unknown };
export type AuthTokens = { access_token: string; refresh_token: string; token_type: string; expires_in: number; user?: AuthUser };
export type ApproveContext = { api: ApproveApiClient; db: ApproveApiClient; profile: ApiRecord };
export type ProjectScope = "public" | "workspace" | "departments";
export type StatusColor = "slate" | "blue" | "amber" | "green" | "red" | "purple" | "pink";
export type IssueStatusCategory = "backlog" | "unstarted" | "started" | "completed" | "canceled" | "duplicate";
export type IssuePriority = "low" | "normal" | "high" | "urgent";
export type ProjectLabel = { tag: string; label: string };
export type IssueLabel = { id: string; workspaceId: string; name: string; color: StatusColor; archivedAt: string | null };

export function approveApiUrl(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.APPROVE_API_URL?.trim() || DEFAULT_APPROVE_API_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("APPROVE_API_URL must be a valid URL.", "invalid_configuration", 2);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new CliError("APPROVE_API_URL must use HTTPS unless it targets localhost.", "invalid_configuration", 2);
  }
  return url.toString().replace(/\/+$/, "");
}

type ClientOptions = {
  accessToken?: string;
  refreshToken?: string;
  onTokens?: (tokens: AuthTokens | null) => void;
  baseUrl?: string;
  fetcher?: typeof fetch;
};

export class ApproveApiClient {
  private accessToken?: string;
  private refreshToken?: string;
  private refreshing: Promise<void> | null = null;
  private readonly fetcher: typeof fetch;
  readonly baseUrl: string;

  constructor(private readonly options: ClientOptions = {}) {
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = options.baseUrl ?? approveApiUrl();
  }

  private apply(tokens: AuthTokens) {
    this.accessToken = tokens.access_token;
    this.refreshToken = tokens.refresh_token;
    this.options.onTokens?.(tokens);
  }

  private async refresh() {
    if (!this.refreshToken) throw new CliError("Run `approve auth login` first.", "unauthenticated", 3);
    if (!this.refreshing) {
      this.refreshing = this.request<AuthTokens>("/auth/refresh", { method: "POST", body: JSON.stringify({ refresh_token: this.refreshToken }) }, false)
        .then((tokens) => this.apply(tokens))
        .finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async response(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new CliError("Could not connect to the Approve API.", "unavailable", 1);
    }
    if (response.status === 401 && retry && this.refreshToken && path !== "/auth/refresh") {
      await this.refresh();
      return this.response(path, init, false);
    }
    return response;
  }

  async request<T = ApiRecord>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const response = await this.response(path, init, retry);
    const payload = await response.json().catch(() => null) as { data?: T; error?: { code?: string; message?: string } } | null;
    if (!response.ok || !payload || !("data" in payload)) {
      const code = payload?.error?.code ?? (response.status === 401 ? "unauthenticated" : "api_error");
      const exitCode = response.status === 401 ? 3 : response.status === 403 ? 4 : response.status === 404 ? 5 : response.status === 409 ? 6 : response.status < 500 ? 2 : 1;
      throw new CliError(payload?.error?.message ?? `Approve API request failed (${response.status}).`, code, exitCode);
    }
    return payload.data as T;
  }

  get<T = ApiRecord>(path: string) { return this.request<T>(path); }
  post<T = ApiRecord>(path: string, value?: unknown) { return this.request<T>(path, { method: "POST", body: value === undefined ? undefined : JSON.stringify(value) }); }
  put<T = ApiRecord>(path: string, value?: unknown) { return this.request<T>(path, { method: "PUT", body: value === undefined ? undefined : JSON.stringify(value) }); }
  patch<T = ApiRecord>(path: string, value?: unknown) { return this.request<T>(path, { method: "PATCH", body: value === undefined ? undefined : JSON.stringify(value) }); }
  delete<T = ApiRecord>(path: string) { return this.request<T>(path, { method: "DELETE" }); }

  async upload<T = ApiRecord>(path: string, file: { name: string; bytes: ArrayBufferView | ArrayBuffer; type?: string }) {
    return this.request<T>(path, {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream", "X-Approve-Filename": file.name },
      body: file.bytes as BodyInit,
    });
  }

  async download(path: string) {
    const response = await this.response(path, { headers: { Accept: "application/octet-stream" } });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
      throw new CliError(payload?.error?.message ?? "Download failed.", payload?.error?.code ?? "download_failed", response.status === 404 ? 5 : 1);
    }
    return response;
  }

  async login(email: string, password: string) {
    const tokens = await this.request<AuthTokens>("/auth/login", { method: "POST", body: JSON.stringify({ email: email.trim().toLowerCase(), password }) }, false);
    this.apply(tokens);
    return tokens;
  }

  async logout() {
    if (this.refreshToken) await this.post("/auth/logout", { refresh_token: this.refreshToken }).catch(() => undefined);
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.options.onTokens?.(null);
  }
}

const s = encodeURIComponent;
const wp = (workspace: string) => `/workspaces/${s(workspace)}`;
const pp = (workspace: string, project: string) => `${wp(workspace)}/projects/${s(project)}`;
const apiOf = (value: ApproveContext | ApproveApiClient) => value instanceof ApproveApiClient ? value : value.api;

export const issueRouteId = (prefix: string | null | undefined, issueNumber: number | null | undefined, id: string) => issueNumber ? `${(prefix || "ISS").toUpperCase()}-${issueNumber}` : id;
export const projectScope = (project: ApiRecord): ProjectScope => project.visibility === "public" ? "public" : project.audience === "departments" ? "departments" : "workspace";

export const listWorkspaces = (context: ApproveContext) => context.api.get<ApiRecord[]>("/workspaces");
export const listWorkspaceProjects = (api: ApproveApiClient, workspace: string) => api.get<ApiRecord>(`${wp(workspace)}/projects`);
export const loadProjectSettings = (context: ApproveContext, workspace: string, project: string) => context.api.get<ApiRecord>(pp(workspace, project));
export const listIssueStatuses = (api: ApproveApiClient, workspace: string, archived = false) => api.get<ApiRecord[]>(`${wp(workspace)}/statuses?archived=${archived}`);
export const listIssueLabels = (api: ApproveApiClient, workspace: string, archived = false) => api.get<IssueLabel[]>(`${wp(workspace)}/issue-labels?archived=${archived}`);
export const listDepartments = (api: ApproveApiClient, workspace: string) => api.get<ApiRecord[]>(`${wp(workspace)}/departments`);
export async function loadTeam(api: ApproveApiClient, workspace: string) {
  const [detail, members, departments, pendingInvitations] = await Promise.all([
    api.get<ApiRecord>(wp(workspace)), api.get<ApiRecord[]>(`${wp(workspace)}/members`), api.get<ApiRecord[]>(`${wp(workspace)}/departments`), api.get<ApiRecord[]>(`${wp(workspace)}/invitations`),
  ]);
  return { workspace: { role: detail.role }, members, departments, pendingInvitations };
}
export const listWorkspaceIssues = (api: ApproveApiClient, workspace: string, options: { projectSlug?: string; labelIds?: string[] } = {}) => {
  const search = new URLSearchParams();
  if (options.projectSlug) search.set("project", options.projectSlug);
  for (const labelId of options.labelIds ?? []) search.append("label", labelId);
  return api.get<ApiRecord>(`${wp(workspace)}/issues${search.size ? `?${search}` : ""}`);
};
export const loadIssue = (api: ApproveApiClient, workspace: string, _project: string, issue: string) => api.get<ApiRecord>(`${wp(workspace)}/issues/${s(issue)}`);
export const listComments = (api: ApproveApiClient, workspace: string, issue: string) => api.get<ApiRecord>(`${wp(workspace)}/issues/${s(issue)}/comments`);
export const loadProjectTimeline = (context: ApproveContext, workspace: string, project: string) => context.api.get<ApiRecord>(`${pp(workspace, project)}/entries`);
export const loadEntry = (api: ApproveApiClient, workspace: string, project: string, entry: string) => api.get<ApiRecord>(`${pp(workspace, project)}/entries/${s(entry)}`);
export const listIssueImages = (api: ApproveApiClient, workspace: string, issue: string) => api.get<ApiRecord[]>(`${wp(workspace)}/issues/${s(issue)}/images`);
export const listProjectLabels = (api: ApproveApiClient, workspace: string, project: string) => api.get<ApiRecord[]>(`${pp(workspace, project)}/labels`);

export const createJourneyWorkspace = (context: ApproveContext, input: ApiRecord) => context.api.post<ApiRecord>("/workspaces", input);
export const createJourneyProject = (context: ApproveContext, workspace: string, input: ApiRecord) => context.api.post<ApiRecord>(`${wp(workspace)}/projects`, input);
export const updateJourneyProject = (context: ApproveContext, workspace: string, project: string, input: ApiRecord) => context.api.patch<ApiRecord>(pp(workspace, project), input);
export const setJourneyProjectRole = (context: ApproveContext, workspace: string, project: string, member: string, role: string) => context.api.put<ApiRecord>(`${pp(workspace, project)}/roles/${s(member)}`, { role });
export const removeJourneyProjectRole = (context: ApproveContext, workspace: string, project: string, member: string) => context.api.delete<ApiRecord>(`${pp(workspace, project)}/roles/${s(member)}`);
export const createJourneyStatus = (context: ApproveContext, workspace: string, input: ApiRecord) => context.api.post<ApiRecord>(`${wp(workspace)}/statuses`, input);
export const updateJourneyStatus = (context: ApproveContext, workspace: string, status: string, input: ApiRecord) => context.api.patch<ApiRecord>(`${wp(workspace)}/statuses/${s(status)}`, input);
export const moveJourneyStatus = (context: ApproveContext, workspace: string, status: string, move: -1 | 1) => context.api.patch<ApiRecord>(`${wp(workspace)}/statuses/${s(status)}`, { move });
export const createJourneyIssueLabel = (context: ApproveContext, workspace: string, input: { name: string; color: StatusColor }) => context.api.post<IssueLabel>(`${wp(workspace)}/issue-labels`, input);
export const updateJourneyIssueLabel = (context: ApproveContext, workspace: string, label: string, input: Partial<{ name: string; color: StatusColor; archived: boolean }>) => context.api.patch<IssueLabel>(`${wp(workspace)}/issue-labels/${s(label)}`, input);
export const createJourneyDepartment = (context: ApproveContext, workspace: string, name: string) => context.api.post<ApiRecord>(`${wp(workspace)}/departments`, { name });
export const renameJourneyDepartment = (context: ApproveContext, workspace: string, department: string, name: string) => context.api.patch<ApiRecord>(`${wp(workspace)}/departments/${s(department)}`, { name });
export const setJourneyDepartmentArchived = (context: ApproveContext, workspace: string, department: string, archived: boolean) => context.api.patch<ApiRecord>(`${wp(workspace)}/departments/${s(department)}`, { archived });
export const updateJourneyMember = (context: ApproveContext, workspace: string, member: string, input: ApiRecord) => context.api.patch<ApiRecord>(`${wp(workspace)}/members/${s(member)}`, input);
export const removeJourneyMember = (context: ApproveContext, workspace: string, member: string) => context.api.delete<ApiRecord>(`${wp(workspace)}/members/${s(member)}`);
export const createJourneyInvitation = (context: ApproveContext, workspace: string, input: ApiRecord) => context.api.post<ApiRecord>(`${wp(workspace)}/invitations`, input);
export const revokeJourneyInvitation = (context: ApproveContext, workspace: string, invitation: string) => context.api.delete<ApiRecord>(`${wp(workspace)}/invitations/${s(invitation)}`);
export const createJourneyIssue = (context: ApproveContext, workspace: string, input: ApiRecord) => context.api.post<ApiRecord>(`${wp(workspace)}/issues`, input);
export const updateJourneyIssue = (context: ApproveContext, workspace: string, issue: string, input: ApiRecord) => context.api.patch<ApiRecord>(`${wp(workspace)}/issues/${s(issue)}`, input);
export const deleteJourneyIssue = (context: ApproveContext, workspace: string, issue: string) => context.api.delete<ApiRecord>(`${wp(workspace)}/issues/${s(issue)}`);
export const createJourneyComment = (context: ApproveContext, workspace: string, issue: string, value: string) => context.api.post<ApiRecord>(`${wp(workspace)}/issues/${s(issue)}/comments`, { body: value });
export const updateJourneyComment = (context: ApproveContext, workspace: string, comment: string, value: string) => context.api.patch<ApiRecord>(`${wp(workspace)}/comments/${s(comment)}`, { body: value });
export const deleteJourneyComment = (context: ApproveContext, workspace: string, comment: string) => context.api.delete<ApiRecord>(`${wp(workspace)}/comments/${s(comment)}`);
export const createJourneyEntry = (context: ApproveContext, workspace: string, project: string, input: ApiRecord) => context.api.post<ApiRecord>(`${pp(workspace, project)}/entries`, input);
export const updateJourneyEntry = (context: ApproveContext, workspace: string, project: string, entry: string, input: ApiRecord) => context.api.patch<ApiRecord>(`${pp(workspace, project)}/entries/${s(entry)}`, input);
export const setJourneyEntryPublished = (context: ApproveContext, workspace: string, project: string, entry: string, published: boolean) => context.api.patch<ApiRecord>(`${pp(workspace, project)}/entries/${s(entry)}`, { published });
export const deleteJourneyEntry = (context: ApproveContext, workspace: string, project: string, entry: string) => context.api.delete<ApiRecord>(`${pp(workspace, project)}/entries/${s(entry)}`);
export const createJourneyLabel = (context: ApproveContext, workspace: string, project: string, label: string) => context.api.post<ApiRecord>(`${pp(workspace, project)}/labels`, { label });
export const renameJourneyLabel = (context: ApproveContext, workspace: string, project: string, tag: string, label: string) => context.api.patch<ApiRecord>(`${pp(workspace, project)}/labels/${s(tag)}`, { label });
export const deleteJourneyLabel = (context: ApproveContext, workspace: string, project: string, tag: string) => context.api.delete<ApiRecord>(`${pp(workspace, project)}/labels/${s(tag)}`);
export const uploadJourneyAttachment = (context: ApproveContext, workspace: string, project: string, entry: string, file: { name: string; bytes: ArrayBufferView | ArrayBuffer; type?: string }) => context.api.upload<ApiRecord>(`${pp(workspace, project)}/entries/${s(entry)}/attachments`, file);
export const removeJourneyAttachment = (context: ApproveContext, workspace: string, attachment: string) => context.api.delete<ApiRecord>(`${wp(workspace)}/attachments/${s(attachment)}`);
export const uploadJourneyIssueImage = (context: ApproveContext, workspace: string, issue: string, file: { name: string; bytes: ArrayBufferView | ArrayBuffer; type?: string }) => context.api.upload<ApiRecord>(`${wp(workspace)}/issues/${s(issue)}/images`, file);
export const removeJourneyIssueImage = (context: ApproveContext, workspace: string, image: string) => context.api.delete<ApiRecord>(`${wp(workspace)}/images/${s(image)}`);

export const apiFrom = apiOf;
