import type { AuthTokens } from "@loomup/client";
import type { Db, Issues, Projects, User, Workspaces } from "../../astro/src/lib/loomup.generated";
import { createDb } from "../../astro/src/lib/loomup.generated";
import type { JourneyContext } from "../../astro/src/lib/auth-client";
import {
  listIssuePeople,
  listIssueStatuses,
  listWorkspaceProjects,
  listWorkspaces,
  loadTeam,
  seedCurrentProfile,
  workspaceBySlug,
} from "../../astro/src/lib/journey-data";
import { parseIssueRouteId } from "../../astro/src/lib/route-identifiers";
import { CliConfigStore, type StoredContext, type StoredSelection } from "./config.js";
import { CliError } from "./errors.js";
import type { CliIo } from "./io.js";

export type ScopeOverrides = { workspace?: string; project?: string };
export type ResolvedScope = { context: JourneyContext; workspace: Workspaces; project?: Projects };

function matches(value: string, ...candidates: Array<string | number | null | undefined>) {
  const normalized = value.toLowerCase();
  return candidates.some((candidate) => candidate != null && String(candidate).toLowerCase() === normalized);
}

function selection(value: { id: string; slug: string; name: string }): StoredSelection {
  return { id: String(value.id), slug: value.slug, name: value.name };
}

export class CliRuntime {
  private dbValue: Db | null = null;
  private contextValue: JourneyContext | null = null;

  constructor(readonly io: CliIo, readonly store = new CliConfigStore()) {}

  async login(email: string, password: string) {
    let db: Db;
    db = createDb({
      onTokens: (tokens) => this.persistTokens(db.url, tokens),
    });
    const tokens = await db.auth.signIn({ email: email.trim().toLowerCase(), password });
    this.store.writeTokens(db.url, tokens);
    this.dbValue = db;
    this.contextValue = await this.loadContext(db);
    const workspaces = await listWorkspaces(this.contextValue);
    const current = this.store.readContext();
    if (!current.workspace && workspaces.length === 1) {
      const workspace = workspaces[0]!;
      this.store.writeContext({ version: 1, workspace: selection(workspace) });
    }
    return { user: tokens.user ?? await db.auth.me(), workspaces };
  }

  async authStatus() {
    const context = await this.authenticated();
    return { user: await context.db.auth.me(), profile: context.profile, context: this.store.readContext() };
  }

  async logout() {
    const credentials = this.store.readCredentials();
    if (credentials) {
      const db = createDb({
        url: credentials.projectUrl,
        token: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        onTokens: (tokens) => this.persistTokens(credentials.projectUrl, tokens),
      });
      await db.auth.signOut().catch(() => undefined);
    }
    this.store.clearCredentials();
    this.dbValue = null;
    this.contextValue = null;
  }

  private persistTokens(projectUrl: string, tokens: AuthTokens | null) {
    if (tokens) this.store.writeTokens(projectUrl, tokens);
    else this.store.clearCredentials();
  }

  private async loadContext(db: Db): Promise<JourneyContext> {
    const identity = await db.auth.me();
    const profile = await db.user.get(identity.id);
    seedCurrentProfile(db, profile);
    return { db, profile };
  }

  async authenticated() {
    if (this.contextValue) return this.contextValue;
    const credentials = this.store.readCredentials();
    if (!credentials) throw new CliError("Run `approve auth login` first.", "unauthenticated", 3);
    const db = createDb({
      url: credentials.projectUrl,
      token: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      onTokens: (tokens) => this.persistTokens(credentials.projectUrl, tokens),
    });
    this.dbValue = db;
    this.contextValue = await this.loadContext(db);
    return this.contextValue;
  }

  close() {
    this.dbValue?.closeRealtime();
  }

  storedContext() {
    return this.store.readContext();
  }

  clearStoredContext() {
    this.store.clearContext();
  }

  async setStoredContext(input: ScopeOverrides) {
    const context = await this.authenticated();
    const current = this.store.readContext();
    const workspace = input.workspace
      ? await this.resolveWorkspace(context, input.workspace)
      : current.workspace
        ? await this.resolveWorkspace(context, current.workspace.id)
        : null;
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
    const project = await this.resolveProject(context, workspace, projectKey);
    return { context, workspace, project };
  }

  async resolveWorkspace(context: JourneyContext, key: string) {
    const workspaces = await listWorkspaces(context);
    const found = workspaces.find((workspace) => matches(key, workspace.id, workspace.slug));
    if (!found) throw new CliError(`Workspace ${key} was not found or is not accessible.`, "not_found", 5);
    return workspaceBySlug(context.db, found.slug);
  }

  async resolveProject(context: JourneyContext, workspace: Workspaces, key: string) {
    const catalog = await listWorkspaceProjects(context.db, workspace.slug, { includeCounts: false });
    const found = catalog.projects.find((project) => matches(key, project.id, project.slug));
    if (!found || !found.access.canRead) throw new CliError(`Project ${key} was not found or is not accessible.`, "not_found", 5);
    return context.db.projects.get(found.id);
  }

  async resolvePerson(context: JourneyContext, workspace: Workspaces, key: string): Promise<User> {
    const normalized = key.replace(/^@/, "").toLowerCase();
    const people = await listIssuePeople(context.db, workspace.slug);
    const person = people.find((item) => matches(normalized, item.id, item.handle));
    if (person) return context.db.user.get(person.id);
    if (key.includes("@")) {
      const { data } = await context.db.user.find({ where: { email: key.toLowerCase() }, limit: 1 });
      if (data[0]) return data[0];
    }
    throw new CliError(`Workspace member ${key} was not found.`, "not_found", 5);
  }

  async resolveDepartment(context: JourneyContext, workspace: Workspaces, key: string) {
    const { data } = await context.db.departments.find({ where: { workspace_id: workspace.id }, limit: 200 });
    const found = data.find((department) => matches(key, department.id, department.name, department.name_key));
    if (!found) throw new CliError(`Department ${key} was not found.`, "not_found", 5);
    return found;
  }

  async resolveStatus(context: JourneyContext, workspace: Workspaces, key: string, includeArchived = true) {
    const statuses = await listIssueStatuses(context.db, workspace.slug, includeArchived);
    const found = statuses.find((status) => matches(key, status.id, status.name));
    if (!found) throw new CliError(`Status ${key} was not found.`, "not_found", 5);
    return found;
  }

  async resolveIssue(context: JourneyContext, workspace: Workspaces, key: string): Promise<Issues> {
    const route = parseIssueRouteId(key);
    let issue: Issues | undefined;
    if (route && route.prefix === workspace.issue_prefix.toUpperCase()) {
      issue = (await context.db.issues.find({ where: { workspace_id: workspace.id, issue_number: route.issueNumber }, limit: 1 })).data[0];
    } else {
      issue = await context.db.issues.get(key).catch(() => undefined);
    }
    if (!issue || String(issue.workspace_id) !== String(workspace.id) || issue.deleted_at) throw new CliError(`Issue ${key} was not found.`, "not_found", 5);
    return issue;
  }

  async resolveEntry(context: JourneyContext, workspace: Workspaces, project: Projects, key: string) {
    const entry = await context.db.timeline_entries.get(key).catch(() => undefined);
    if (!entry || String(entry.workspace_id) !== String(workspace.id) || String(entry.project_id) !== String(project.id) || entry.deleted_at) throw new CliError(`Entry ${key} was not found.`, "not_found", 5);
    return entry;
  }

  async team(workspace: Workspaces) {
    return loadTeam((await this.authenticated()).db, workspace.slug);
  }
}
