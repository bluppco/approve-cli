import { version } from "../package.json";
import { registerResourceCommands } from "./resources.js";
import { registerDocumentCommands } from "./documents.js";
import { registerNotificationCommands } from "./notifications.js";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Command, Option } from "commander";
import {
  createJourneyComment,
  createJourneyDepartment,
  createJourneyEntry,
  createJourneyInvitation,
  createJourneyIssue,
  createJourneyIssueLabel,
  createJourneyLabel,
  createJourneyProject,
  createJourneyStatus,
  createJourneyWorkspace,
  deleteJourneyComment,
  deleteJourneyEntry,
  deleteJourneyIssue,
  deleteJourneyLabel,
  moveJourneyStatus,
  projectScope,
  removeJourneyAttachment,
  removeJourneyIssueImage,
  removeJourneyIssueAttachment,
  removeJourneyMember,
  removeJourneyProjectRole,
  renameJourneyDepartment,
  renameJourneyLabel,
  revokeJourneyInvitation,
  setJourneyDepartmentArchived,
  setJourneyEntryPublished,
  setJourneyProjectRole,
  updateJourneyComment,
  updateJourneyEntry,
  updateJourneyIssue,
  updateJourneyIssueLabel,
  updateJourneyMember,
  updateJourneyProject,
  updateJourneyStatus,
  uploadJourneyAttachment,
  uploadJourneyIssueImage,
  uploadJourneyIssueAttachment,
  stageJourneyCommentAttachment,
  issueRouteId,
  listComments,
  listDepartments,
  listIssueImages,
  listIssueLabels,
  listIssueStatuses,
  listProjectLabels,
  listWorkspaceIssues,
  listWorkspaces,
  loadEntry,
  loadIssue,
  loadProjectSettings,
  loadProjectTimeline,
  loadTeam,
  type ProjectScope,
  type StatusColor,
  type ApiRecord,
  type IssuePriority,
  type ProjectLabel,
  type IssueStatusCategory,
} from "./api-client.js";
import { CliError } from "./errors.js";
import { CliOutput, confirmDestructive, textFromOptions } from "./io.js";
import { CliRuntime, type ScopeOverrides } from "./runtime.js";

type GlobalOptions = ScopeOverrides & { json?: boolean; yes?: boolean; noColor?: boolean };

const priorities = ["low", "normal", "high", "urgent"] as const;
const statusColors = ["slate", "blue", "amber", "green", "red", "purple", "pink"] as const;
const statusCategories = ["backlog", "unstarted", "started", "completed", "canceled", "duplicate"] as const;

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function output(runtime: CliRuntime, command: Command) {
  return new CliOutput(runtime.io, Boolean(globals(command).json));
}

function overrides(command: Command, extra: ScopeOverrides = {}): ScopeOverrides {
  const options = globals(command);
  return { workspace: extra.workspace ?? options.workspace, project: extra.project ?? options.project };
}

function collect(value: string, previous: string[] = []) {
  return [...previous, value];
}

function asProjectScope(value: string): ProjectScope {
  if (!(["public", "workspace", "restricted", "departments"] as const).includes(value as ProjectScope)) throw new CliError("Scope must be public, workspace, restricted, or departments.", "invalid_input", 2);
  return value as ProjectScope;
}

function asPriority(value: string): IssuePriority {
  if (!priorities.includes(value as IssuePriority)) throw new CliError(`Priority must be one of: ${priorities.join(", ")}.`, "invalid_input", 2);
  return value as IssuePriority;
}

function asStatusColor(value: string): StatusColor {
  if (!statusColors.includes(value as StatusColor)) throw new CliError(`Color must be one of: ${statusColors.join(", ")}.`, "invalid_input", 2);
  return value as StatusColor;
}

function asStatusCategory(value: string): IssueStatusCategory {
  if (!statusCategories.includes(value as IssueStatusCategory)) throw new CliError(`Category must be one of: ${statusCategories.join(", ")}.`, "invalid_input", 2);
  return value as IssueStatusCategory;
}

function asPositiveInteger(value: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new CliError("Value must be a positive integer.", "invalid_input", 2);
  return parsed;
}

function parseDateTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new CliError("Date and time must be a valid ISO 8601 value.", "invalid_input", 2);
  return timestamp;
}

function labels(values: string[] | undefined): ProjectLabel[] | undefined {
  return values?.map((label) => ({ tag: "", label }));
}

async function uploadedFile(path: string) {
  const absolute = resolve(path);
  return { name: basename(absolute), bytes: await readFile(absolute) };
}

function responseFileName(response: Response, fallback: string) {
  const value = response.headers.get("Content-Disposition") ?? "";
  return value.match(/filename="([^"]+)"/i)?.[1] ?? fallback;
}

async function resolvedDepartments(runtime: CliRuntime, scope: Awaited<ReturnType<CliRuntime["scope"]>>, values: string[] | undefined) {
  if (values === undefined) return undefined;
  return Promise.all(values.map(async (value) => (await runtime.resolveDepartment(scope.context, scope.workspace, value)).id));
}

async function projectScopeFor(runtime: CliRuntime, command: Command, projectKey?: string) {
  return runtime.scope(overrides(command, projectKey ? { project: projectKey } : {}), { project: "required" });
}

function workspaceRow(workspace: ApiRecord) {
  return { slug: workspace.slug, name: workspace.name, role: workspace.role, default: workspace.isDefault ?? false, id: workspace.id };
}

function projectRow(project: ApiRecord) {
  return { slug: project.slug, name: project.name, scope: project.visibility === "public" ? "public" : project.audience === "departments" ? "restricted" : "workspace", role: project.role ?? "—", issues: project.unresolvedIssueCount ?? "—", entries: project.entryCount ?? "—", id: project.id };
}

function issueRow(issue: ApiRecord) {
  return { key: issue.publicId, title: issue.title, project: issue.project.slug, status: issue.status.name, blocked: issue.isBlocked ? `Yes (${issue.unresolvedBlockerCount})` : "No", labels: issue.labels?.map((label: ApiRecord) => label.name).join(", ") || "—", priority: issue.priority, assignee: issue.assignee?.handle ?? "—", due: issue.dueDate ?? "—", updated: issue.updatedAt };
}

async function resolvedIssueLabels(runtime: CliRuntime, scope: Awaited<ReturnType<CliRuntime["scope"]>>, values: string[] | undefined, includeArchived = false) {
  if (values === undefined) return undefined;
  return Promise.all(values.map((value) => runtime.resolveIssueLabel(scope.context, scope.workspace, value, includeArchived)));
}

export function createProgram(runtime: CliRuntime) {
  const program = new Command();
  program
    .name("approve")
    .description("Manage Approve from a terminal or local coding agent")
    .version(version)
    .option("-w, --workspace <workspace>", "workspace slug or id")
    .option("-p, --project <project>", "project slug or id")
    .option("--json", "emit stable JSON envelopes")
    .option("--yes", "confirm destructive actions without prompting")
    .option("--no-color", "disable terminal color")
    .showHelpAfterError()
    .configureOutput({
      writeOut: (value) => runtime.io.stdout.write(value),
      writeErr: (value) => runtime.io.stderr.write(value),
    });

  const auth = program.command("auth").description("Manage the local Approve session");
  auth.command("login")
    .description("Sign in through approve.so and save a refreshable local session")
    .option("--no-browser", "print the approval URL without opening it")
    .action(async (options: { browser?: boolean }, command: Command) => {
      const result = await runtime.login({ browser: options.browser });
      output(runtime, command).data({ email: result.user.email, workspaces: result.workspaces.length, message: "Signed in." });
    });
  auth.command("status")
    .description("Show the signed-in account and saved context")
    .action(async (_options: unknown, command: Command) => {
      const result = await runtime.authStatus();
      output(runtime, command).data({ email: result.user.email, name: result.profile.name, handle: result.profile.handle, workspace: result.context.workspace?.slug ?? null, project: result.context.project?.slug ?? null });
    });
  auth.command("logout")
    .description("Revoke and remove the local session")
    .action(async (_options: unknown, command: Command) => {
      await runtime.logout();
      output(runtime, command).data({ ok: true, message: "Signed out." });
    });

  const contextCommand = program.command("context").description("Manage the saved workspace and project defaults");
  contextCommand.command("show").action((_options: unknown, command: Command) => output(runtime, command).data(runtime.storedContext()));
  contextCommand.command("set")
    .description("Save the global --workspace and optional --project as defaults")
    .action(async (_options: unknown, command: Command) => {
      const value = await runtime.setStoredContext(overrides(command));
      output(runtime, command).data(value);
    });
  contextCommand.command("clear")
    .description("Clear saved defaults without logging out")
    .action((_options: unknown, command: Command) => {
      runtime.clearStoredContext();
      output(runtime, command).data({ ok: true });
    });

  const workspaces = program.command("workspaces").description("List and create workspaces");
  workspaces.command("list").action(async (_options: unknown, command: Command) => {
    const context = await runtime.authenticated();
    const rows = await listWorkspaces(context);
    output(runtime, command).data(globals(command).json ? rows : rows.map(workspaceRow));
  });
  workspaces.command("show [workspace]").action(async (workspaceKey: string | undefined, _options: unknown, command: Command) => {
    const context = await runtime.authenticated();
    const scope = await runtime.scope(overrides(command, workspaceKey ? { workspace: workspaceKey } : {}), { project: "none" });
    const team = await loadTeam(context.api, scope.workspace.slug);
    output(runtime, command).data({ ...scope.workspace, role: team.workspace.role, members: team.members.length, departments: team.departments.length, pendingInvitations: team.pendingInvitations.length });
  });
  workspaces.command("create <name>")
    .option("--slug <slug>", "workspace URL slug")
    .option("--use", "save the new workspace as the default context")
    .action(async (name: string, options: { slug?: string; use?: boolean }, command: Command) => {
      const context = await runtime.authenticated();
      const workspace = await createJourneyWorkspace(context, { name, slug: options.slug });
      if (options.use) await runtime.setStoredContext({ workspace: workspace.id });
      output(runtime, command).data(workspace);
    });

  const projects = program.command("projects").description("Manage projects and their audiences");
  projects.command("list").action(async (_options: unknown, command: Command) => {
    const result = await runtime.listProjects(overrides(command));
    output(runtime, command).data(globals(command).json ? result.projects : result.projects.filter((project: ApiRecord) => project.access.canRead).map(projectRow));
  });
  projects.command("show [project]").action(async (projectKey: string | undefined, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command, projectKey);
    const settings = await loadProjectSettings(scope.context, scope.workspace.slug, scope.project!.id);
    output(runtime, command).data(settings);
  });
  projects.command("create <name>")
    .option("--summary <summary>", "short project description", "")
    .option("--slug <slug>", "project URL slug")
    .addOption(new Option("--scope <scope>", "reading audience").choices(["public", "workspace", "restricted", "departments"]))
    .option("--department <department>", "department name or id (repeatable)", collect, [])
    .option("--use", "save the new project as the default context")
    .action(async (name: string, options: { summary: string; slug?: string; scope?: string; department: string[]; use?: boolean }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const departmentIds = await resolvedDepartments(runtime, scope, options.department);
      const project = await createJourneyProject(scope.context, scope.workspace.slug, { name, summary: options.summary, slug: options.slug, scope: options.scope ? asProjectScope(options.scope) : undefined, departmentIds });
      if (options.use) await runtime.setStoredContext({ workspace: scope.workspace.id, project: project.id });
      output(runtime, command).data(project);
    });
  projects.command("update [project]")
    .option("--name <name>", "project name")
    .option("--summary <summary>", "short project description")
    .option("--slug <slug>", "project URL slug")
    .addOption(new Option("--scope <scope>", "reading audience").choices(["public", "workspace", "restricted", "departments"]))
    .option("--department <department>", "replace audience departments (repeatable)", collect)
    .action(async (projectKey: string | undefined, options: { name?: string; summary?: string; slug?: string; scope?: string; department?: string[] }, command: Command) => {
      const scope = await projectScopeFor(runtime, command, projectKey);
      const settings = await loadProjectSettings(scope.context, scope.workspace.slug, scope.project!.id);
      const departmentIds = options.department === undefined ? settings.selectedDepartmentIds : await resolvedDepartments(runtime, scope, options.department);
      const project = await updateJourneyProject(scope.context, scope.workspace.slug, scope.project!.id, {
        name: options.name ?? settings.project.name,
        summary: options.summary ?? settings.project.summary,
        slug: options.slug ?? settings.project.slug,
        scope: options.scope ? asProjectScope(options.scope) : projectScope(scope.project!),
        departmentIds,
      });
      output(runtime, command).data(project);
    });

  const roles = program.command("project-roles").description("Manage project viewers, editors, and owners");
  roles.command("list").action(async (_options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    const settings = await loadProjectSettings(scope.context, scope.workspace.slug, scope.project!.id);
    output(runtime, command).data(settings.members.map((member: ApiRecord) => ({ handle: member.handle, name: member.name, email: member.email, role: member.role, id: member.userId })));
  });
  roles.command("set <member>")
    .addOption(new Option("--role <role>").choices(["owner", "editor", "viewer"]).makeOptionMandatory())
    .action(async (memberKey: string, options: { role: "owner" | "editor" | "viewer" }, command: Command) => {
      const scope = await projectScopeFor(runtime, command);
      const member = await runtime.resolvePerson(scope.context, scope.workspace, memberKey);
      const role = await setJourneyProjectRole(scope.context, scope.workspace.slug, scope.project!.id, member.id, options.role);
      output(runtime, command).data(role);
    });
  roles.command("remove <member>").action(async (memberKey: string, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    const member = await runtime.resolvePerson(scope.context, scope.workspace, memberKey);
    await confirmDestructive(runtime.io, `Remove @${member.handle ?? member.email} from this project?`, Boolean(globals(command).yes));
    const removed = await removeJourneyProjectRole(scope.context, scope.workspace.slug, scope.project!.id, member.id);
    output(runtime, command).data(removed);
  });

  const statuses = program.command("statuses").description("Manage the workspace issue workflow");
  statuses.command("list").option("--archived", "include archived statuses").action(async (options: { archived?: boolean }, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const rows = await listIssueStatuses(scope.context.api, scope.workspace.slug, Boolean(options.archived));
    output(runtime, command).data(rows.map((status) => ({ name: status.name, category: status.category, color: status.color, default: status.isDefault ?? false, archived: Boolean(status.archivedAt), position: status.position, id: status.id })));
  });
  statuses.command("create <name>")
    .addOption(new Option("--category <category>").choices([...statusCategories]).makeOptionMandatory())
    .addOption(new Option("--color <color>").choices([...statusColors]).default("blue"))
    .action(async (name: string, options: { category: string; color: string }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const status = await createJourneyStatus(scope.context, scope.workspace.slug, { name, category: asStatusCategory(options.category), color: asStatusColor(options.color) });
      output(runtime, command).data(status);
    });
  statuses.command("update <status>")
    .option("--name <name>")
    .addOption(new Option("--category <category>").choices([...statusCategories]))
    .addOption(new Option("--color <color>").choices([...statusColors]))
    .action(async (statusKey: string, options: { name?: string; category?: string; color?: string }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const status = await runtime.resolveStatus(scope.context, scope.workspace, statusKey);
      if (options.category && options.category !== status.category) {
        const count = await runtime.activeIssueCount(scope.context, scope.workspace, status.id);
        if (count > 0) await confirmDestructive(runtime.io, `Changing this category immediately reclassifies ${count} active issue${count === 1 ? "" : "s"}. Continue?`, Boolean(globals(command).yes));
      }
      const updated = await updateJourneyStatus(scope.context, scope.workspace.slug, status.id, { name: options.name, category: options.category ? asStatusCategory(options.category) : undefined, color: options.color ? asStatusColor(options.color) : undefined });
      output(runtime, command).data(updated);
    });
  statuses.command("move <status>")
    .addOption(new Option("--direction <direction>").choices(["up", "down"]).makeOptionMandatory())
    .action(async (statusKey: string, options: { direction: "up" | "down" }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const status = await runtime.resolveStatus(scope.context, scope.workspace, statusKey);
      output(runtime, command).data(await moveJourneyStatus(scope.context, scope.workspace.slug, status.id, options.direction === "up" ? -1 : 1));
    });
  for (const [name, patch, destructive] of [
    ["set-default", { isDefault: true }, false],
    ["archive", { archived: true }, true],
    ["restore", { archived: false }, false],
  ] as const) {
    statuses.command(`${name} <status>`).action(async (statusKey: string, _options: unknown, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const status = await runtime.resolveStatus(scope.context, scope.workspace, statusKey);
      if (destructive) await confirmDestructive(runtime.io, `Archive ${status.name}?`, Boolean(globals(command).yes));
      output(runtime, command).data(await updateJourneyStatus(scope.context, scope.workspace.slug, status.id, patch));
    });
  }

  const issueLabels = program.command("issue-labels").description("Manage the workspace issue label catalog");
  issueLabels.command("list").option("--archived", "include archived labels").action(async (options: { archived?: boolean }, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    output(runtime, command).data(await listIssueLabels(scope.context.api, scope.workspace.slug, Boolean(options.archived)));
  });
  issueLabels.command("create <name>")
    .addOption(new Option("--color <color>").choices([...statusColors]).default("blue"))
    .action(async (name: string, options: { color: StatusColor }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      output(runtime, command).data(await createJourneyIssueLabel(scope.context, scope.workspace.slug, { name, color: asStatusColor(options.color) }));
    });
  issueLabels.command("update <label>")
    .option("--name <name>")
    .addOption(new Option("--color <color>").choices([...statusColors]))
    .action(async (labelKey: string, options: { name?: string; color?: StatusColor }, command: Command) => {
      if (options.name === undefined && options.color === undefined) throw new CliError("Pass --name or --color.", "invalid_input", 2);
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const label = await runtime.resolveIssueLabel(scope.context, scope.workspace, labelKey);
      output(runtime, command).data(await updateJourneyIssueLabel(scope.context, scope.workspace.slug, label.id, { name: options.name, color: options.color ? asStatusColor(options.color) : undefined }));
    });
  for (const [name, archived] of [["archive", true], ["restore", false]] as const) {
    issueLabels.command(`${name} <label>`).action(async (labelKey: string, _options: unknown, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const label = await runtime.resolveIssueLabel(scope.context, scope.workspace, labelKey);
      if (archived) await confirmDestructive(runtime.io, `Archive ${label.name}? Existing issues will keep it.`, Boolean(globals(command).yes));
      output(runtime, command).data(await updateJourneyIssueLabel(scope.context, scope.workspace.slug, label.id, { archived }));
    });
  }

  const departments = program.command("departments").description("Manage workspace departments");
  departments.command("list").option("--archived", "include archived departments").action(async (options: { archived?: boolean }, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const rows = await listDepartments(scope.context.api, scope.workspace.slug);
    output(runtime, command).data(rows.filter((department) => options.archived || !department.archivedAt));
  });
  departments.command("create <name>").action(async (name: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    output(runtime, command).data(await createJourneyDepartment(scope.context, scope.workspace.slug, name));
  });
  departments.command("rename <department> <name>").action(async (departmentKey: string, name: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const department = await runtime.resolveDepartment(scope.context, scope.workspace, departmentKey);
    output(runtime, command).data(await renameJourneyDepartment(scope.context, scope.workspace.slug, department.id, name));
  });
  for (const [name, archived] of [["archive", true], ["restore", false]] as const) {
    departments.command(`${name} <department>`).action(async (departmentKey: string, _options: unknown, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const department = await runtime.resolveDepartment(scope.context, scope.workspace, departmentKey);
      if (archived) await confirmDestructive(runtime.io, `Archive ${department.name}?`, Boolean(globals(command).yes));
      output(runtime, command).data(await setJourneyDepartmentArchived(scope.context, scope.workspace.slug, department.id, archived));
    });
  }

  const members = program.command("members").description("Manage workspace memberships");
  members.command("list").action(async (_options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const team = await loadTeam(scope.context.api, scope.workspace.slug);
    output(runtime, command).data(team.members.map((member) => ({ handle: member.handle, name: member.name, email: member.email, role: member.role, department: member.departmentName ?? "—", id: member.id })));
  });
  members.command("update <member>")
    .addOption(new Option("--role <role>").choices(["owner", "admin", "member"]))
    .option("--department <department>", "department name or id")
    .option("--clear-department", "remove the department (admins and owners only)")
    .action(async (memberKey: string, options: { role?: "owner" | "admin" | "member"; department?: string; clearDepartment?: boolean }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const member = await runtime.resolvePerson(scope.context, scope.workspace, memberKey);
      const departmentId = options.clearDepartment ? null : options.department ? (await runtime.resolveDepartment(scope.context, scope.workspace, options.department)).id : undefined;
      output(runtime, command).data(await updateJourneyMember(scope.context, scope.workspace.slug, member.id, { role: options.role, departmentId }));
    });
  members.command("remove <member>").action(async (memberKey: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const member = await runtime.resolvePerson(scope.context, scope.workspace, memberKey);
    await confirmDestructive(runtime.io, `Remove ${member.name} from ${scope.workspace.name}?`, Boolean(globals(command).yes));
    output(runtime, command).data(await removeJourneyMember(scope.context, scope.workspace.slug, member.id));
  });

  const invitations = program.command("invitations").description("Create and revoke workspace invitations");
  invitations.command("list").action(async (_options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    output(runtime, command).data((await loadTeam(scope.context.api, scope.workspace.slug)).pendingInvitations);
  });
  invitations.command("create <email>")
    .addOption(new Option("--role <role>").choices(["admin", "member"]).default("member"))
    .option("--department <department>", "required for Member invitations")
    .action(async (email: string, options: { role: "admin" | "member"; department?: string }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const departmentId = options.department ? (await runtime.resolveDepartment(scope.context, scope.workspace, options.department)).id : undefined;
      const result = await createJourneyInvitation(scope.context, scope.workspace.slug, { email, role: options.role, departmentId });
      output(runtime, command).data({ id: result.invitation.id, email: result.invitation.email, role: result.invitation.role, expiresAt: new Date(result.invitation.expires_at).toISOString(), inviteUrl: result.inviteUrl });
    });
  invitations.command("revoke <invitation>").action(async (invitationId: string, _options: unknown, command: Command) => {
    await confirmDestructive(runtime.io, "Revoke this invitation?", Boolean(globals(command).yes));
    const scope = await runtime.scope(overrides(command), { project: "none" });
    output(runtime, command).data(await revokeJourneyInvitation(scope.context, scope.workspace.slug, invitationId));
  });

  const issues = program.command("issues").description("Manage issues");
  const dependencies = issues.command("dependencies").description("Manage Blocking and Blocked by relationships");
  dependencies.command("list <issue>").option("--cursor <cursor>", "next dependency page").action(async (key: string, options: { cursor?: string }, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const issue = await runtime.resolveIssue(scope.context, scope.workspace, key);
    const path = `/workspaces/${encodeURIComponent(scope.workspace.slug)}/issues/${encodeURIComponent(issue.id)}/dependencies`;
    const page = await scope.context.api.get(`${path}${options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ""}`);
    const rows = globals(command).json ? page.dependencies : page.dependencies.map((row: ApiRecord) => ({
      relationship: row.direction === "blocks" ? "Blocking" : "Blocked by", key: row.issue?.publicId ?? "Restricted issue",
      title: row.issue?.title ?? "—", status: row.issue?.status.name ?? "—", assignee: row.issue?.assignee?.name ?? "Unassigned", resolved: row.resolved, id: row.id,
    }));
    output(runtime, command).data(rows, { meta: { nextCursor: page.nextCursor, isBlocked: page.isBlocked, unresolvedBlockerCount: page.unresolvedBlockerCount } });
  });
  for (const action of ["add", "remove"] as const) dependencies.command(`${action} <issue>`)
    .option("--blocks <target>", "this issue blocks the target")
    .option("--blocked-by <target>", "this issue depends on the target")
    .action(async (key: string, options: { blocks?: string; blockedBy?: string }, command: Command) => {
      if (Boolean(options.blocks) === Boolean(options.blockedBy)) throw new CliError("Specify exactly one of --blocks or --blocked-by.", "invalid_input", 2);
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const issue = await runtime.resolveIssue(scope.context, scope.workspace, key);
      const target = await runtime.resolveIssue(scope.context, scope.workspace, (options.blocks ?? options.blockedBy)!);
      const result = await scope.context.api.request(`/workspaces/${encodeURIComponent(scope.workspace.slug)}/issues/${encodeURIComponent(issue.id)}/dependencies`, {
        method: action === "add" ? "POST" : "DELETE", body: JSON.stringify({ target: target.id, direction: options.blocks ? "blocks" : "blocked-by" }),
      });
      output(runtime, command).data(result);
    });
  issues.command("list")
    .option("--status <status>", "status name or id")
    .option("--category <category>", "status category")
    .option("--assignee <member>", "assignee handle or id")
    .option("--label <label>", "issue label name or id (repeatable, matches any)", collect, [])
    .addOption(new Option("--priority <priority>").choices([...priorities]))
    .option("--due <due>", "overdue, today, week, none, or YYYY-MM-DD")
    .option("--limit <limit>", "maximum rows", asPositiveInteger, 200)
    .action(async (options: { status?: string; category?: string; assignee?: string; label: string[]; priority?: IssuePriority; due?: string; limit: number }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "optional" });
      const selectedLabels = await resolvedIssueLabels(runtime, scope, options.label, false) ?? [];
      const result = await listWorkspaceIssues(scope.context.api, scope.workspace.slug, {
        projectSlug: scope.project?.slug,
        labelIds: selectedLabels.map((label) => label.id),
      });
      const status = options.status ? await runtime.resolveStatus(scope.context, scope.workspace, options.status) : undefined;
      const assignee = options.assignee ? await runtime.resolvePerson(scope.context, scope.workspace, options.assignee) : undefined;
      const today = new Date().toISOString().slice(0, 10);
      const week = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const rows = result.issues.filter((issue: ApiRecord) => {
        if (status && issue.statusId !== status.id) return false;
        if (options.category && issue.status.category !== options.category) return false;
        if (assignee && issue.assigneeId !== assignee.id) return false;
        if (options.priority && issue.priority !== options.priority) return false;
        if (options.due === "none" && issue.dueDate) return false;
        if (options.due === "overdue" && (!issue.dueDate || issue.dueDate >= today)) return false;
        if (options.due === "today" && issue.dueDate !== today) return false;
        if (options.due === "week" && (!issue.dueDate || issue.dueDate < today || issue.dueDate >= week)) return false;
        if (options.due && !["none", "overdue", "today", "week"].includes(options.due) && issue.dueDate !== options.due) return false;
        return true;
      }).slice(0, options.limit);
      output(runtime, command).data(globals(command).json ? rows : rows.map(issueRow), { meta: { count: rows.length, nextCursor: result.nextCursor } });
    });
  issues.command("show <issue>").option("--sub-issues-cursor <cursor>", "Load another page of sub-issues").action(async (issueKey: string, options: { subIssuesCursor?: string }, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const record = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
    const detail = await loadIssue(scope.context.api, scope.workspace.slug, record.project_id, issueKey, options.subIssuesCursor);
    const comments = await listComments(scope.context.api, scope.workspace.slug, record.id);
    output(runtime, command).data({ ...detail, comments: comments.comments });
  });
  issues.command("create <title>")
    .option("--parent <issue>", "Create a sub-issue of an issue in the same project")
    .option("--description <markdown>")
    .option("--description-file <path>", "Markdown file, or - for stdin")
    .option("--status <status>")
    .option("--assignee <member>")
    .option("--label <label>", "issue label name or id (repeatable)", collect, [])
    .addOption(new Option("--priority <priority>").choices([...priorities]).default("normal"))
    .option("--due <date>", "YYYY-MM-DD")
    .option("--image <path>", "image to upload (repeatable)", collect, [])
    .option("--attach <path>", "image, video, or PDF to attach (repeatable)", collect, [])
    .action(async (title: string, options: { parent?: string; description?: string; descriptionFile?: string; status?: string; assignee?: string; label: string[]; priority: IssuePriority; due?: string; image: string[]; attach: string[] }, command: Command) => {
      const scope = await projectScopeFor(runtime, command);
      const description = await textFromOptions(runtime.io, options.description, options.descriptionFile, "description") ?? "";
      const statusId = options.status ? (await runtime.resolveStatus(scope.context, scope.workspace, options.status, false)).id : undefined;
      const assigneeId = options.assignee ? (await runtime.resolvePerson(scope.context, scope.workspace, options.assignee)).id : undefined;
      const selectedLabels = await resolvedIssueLabels(runtime, scope, options.label, false) ?? [];
      const parentIssueId = options.parent ? (await runtime.resolveIssue(scope.context, scope.workspace, options.parent)).id : undefined;
      const issue = await createJourneyIssue(scope.context, scope.workspace.slug, { ...(parentIssueId ? { parentIssueId } : {}), projectId: scope.project!.id, title, descriptionMarkdown: description, statusId, assigneeId, labelIds: selectedLabels.map((label) => label.id), priority: asPriority(options.priority), dueDate: options.due });
      const uploaded = [];
      for (const path of options.image) uploaded.push(await uploadJourneyIssueImage(scope.context, scope.workspace.slug, issue.id, await uploadedFile(path)));
      const attachments = [];
      for (const path of options.attach) attachments.push(await uploadJourneyIssueAttachment(scope.context, scope.workspace.slug, issue.id, await uploadedFile(path)));
      output(runtime, command).data({ ...issue, publicId: issueRouteId(scope.workspace.issue_prefix, issue.issue_number, issue.id), images: uploaded.map((item) => ({ ...item.image, markdown: item.markdown })), attachments });
    });
  issues.command("update <issue>")
    .option("--title <title>")
    .option("--description <markdown>")
    .option("--description-file <path>", "Markdown file, or - for stdin")
    .option("--status <status>")
    .option("--assignee <member>")
    .option("--clear-assignee")
    .option("--label <label>", "replace issue labels (repeatable)", collect)
    .option("--clear-labels", "remove all issue labels")
    .addOption(new Option("--priority <priority>").choices([...priorities]))
    .option("--due <date>", "YYYY-MM-DD")
    .option("--clear-due")
    .option("--image <path>", "image to upload (repeatable)", collect, [])
    .option("--attach <path>", "image, video, or PDF to attach (repeatable)", collect, [])
    .action(async (issueKey: string, options: { title?: string; description?: string; descriptionFile?: string; status?: string; assignee?: string; clearAssignee?: boolean; label?: string[]; clearLabels?: boolean; priority?: IssuePriority; due?: string; clearDue?: boolean; image: string[]; attach: string[] }, command: Command) => {
      if (options.label !== undefined && options.clearLabels) throw new CliError("Pass --label or --clear-labels, not both.", "invalid_input", 2);
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
      const description = await textFromOptions(runtime.io, options.description, options.descriptionFile, "description");
      const statusId = options.status ? (await runtime.resolveStatus(scope.context, scope.workspace, options.status, false)).id : undefined;
      const assigneeId = options.clearAssignee ? null : options.assignee ? (await runtime.resolvePerson(scope.context, scope.workspace, options.assignee)).id : undefined;
      const selectedLabels = options.label === undefined ? undefined : await resolvedIssueLabels(runtime, scope, options.label, true);
      const updated = await updateJourneyIssue(scope.context, scope.workspace.slug, issue.id, { title: options.title, descriptionMarkdown: description, statusId, assigneeId, labelIds: options.clearLabels ? [] : selectedLabels?.map((label) => label.id), priority: options.priority, dueDate: options.clearDue ? null : options.due });
      const uploaded = [];
      for (const path of options.image) uploaded.push(await uploadJourneyIssueImage(scope.context, scope.workspace.slug, issue.id, await uploadedFile(path)));
      const attachments = [];
      for (const path of options.attach) attachments.push(await uploadJourneyIssueAttachment(scope.context, scope.workspace.slug, issue.id, await uploadedFile(path)));
      output(runtime, command).data({ ...updated, publicId: issueRouteId(scope.workspace.issue_prefix, updated.issue_number, updated.id), images: uploaded.map((item) => ({ ...item.image, markdown: item.markdown })), attachments });
    });
  issues.command("delete <issue>").action(async (issueKey: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
    await confirmDestructive(runtime.io, `Delete ${issueRouteId(scope.workspace.issue_prefix, issue.issue_number, issue.id)}?`, Boolean(globals(command).yes));
    output(runtime, command).data(await deleteJourneyIssue(scope.context, scope.workspace.slug, issue.id));
  });

  const comments = program.command("comments").description("Manage issue comments");
  comments.command("list <issue>").action(async (issueKey: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
    const result = await listComments(scope.context.api, scope.workspace.slug, issue.id);
    output(runtime, command).data(result.comments, { meta: { nextCursor: result.nextCursor } });
  });
  comments.command("add <issue>")
    .option("--body <markdown>")
    .option("--body-file <path>", "Markdown file, or - for stdin")
    .option("--attach <path>", "image, video, or PDF to attach (repeatable)", collect, [])
    .action(async (issueKey: string, options: { body?: string; bodyFile?: string; attach: string[] }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
      const body = await textFromOptions(runtime.io, options.body, options.bodyFile, "body");
      if (body === undefined && options.attach.length === 0) throw new CliError("Pass --body, --body-file, or at least one --attach.", "invalid_input", 2);
      const attachments = [];
      for (const path of options.attach) attachments.push(await stageJourneyCommentAttachment(scope.context, scope.workspace.slug, issue.id, await uploadedFile(path)));
      const result = await createJourneyComment(scope.context, scope.workspace.slug, issue.id, body ?? "", attachments);
      if (result.mentionFailures) output(runtime, command).warning("The comment was saved, but one or more mention notifications failed.");
      output(runtime, command).data(result.comment);
    });
  comments.command("update <comment>")
    .option("--body <markdown>")
    .option("--body-file <path>", "Markdown file, or - for stdin")
    .option("--issue <issue>", "issue key (required with --attach)")
    .option("--attach <path>", "image, video, or PDF to attach (repeatable)", collect, [])
    .action(async (commentId: string, options: { body?: string; bodyFile?: string; issue?: string; attach: string[] }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const body = await textFromOptions(runtime.io, options.body, options.bodyFile, "body");
      if (body === undefined) throw new CliError("--body or --body-file is required.", "invalid_input", 2);
      if (options.attach.length && !options.issue) throw new CliError("--issue is required when attaching files to an existing comment.", "invalid_input", 2);
      const attachments = [];
      if (options.issue) {
        const issue = await runtime.resolveIssue(scope.context, scope.workspace, options.issue);
        for (const path of options.attach) attachments.push(await stageJourneyCommentAttachment(scope.context, scope.workspace.slug, issue.id, await uploadedFile(path)));
      }
      const result = await updateJourneyComment(scope.context, scope.workspace.slug, commentId, body, attachments);
      if (result.mentionFailures) output(runtime, command).warning("The comment was saved, but one or more mention notifications failed.");
      output(runtime, command).data(result.comment);
    });
  comments.command("delete <comment>").action(async (commentId: string, _options: unknown, command: Command) => {
    await confirmDestructive(runtime.io, "Delete this comment?", Boolean(globals(command).yes));
    const scope = await runtime.scope(overrides(command), { project: "none" });
    output(runtime, command).data(await deleteJourneyComment(scope.context, scope.workspace.slug, commentId));
  });

  registerDocumentCommands(program, runtime);
  registerResourceCommands(program, runtime);
  registerNotificationCommands(program, runtime);

  const entries = program.command("entries").description("Manage project timeline entries");
  entries.command("list").action(async (_options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    const result = await loadProjectTimeline(scope.context, scope.workspace.slug, scope.project!.id);
    output(runtime, command).data(result.entries);
  });
  entries.command("show <entry>").action(async (entryId: string, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    output(runtime, command).data(await loadEntry(scope.context.api, scope.workspace.slug, scope.project!.id, entryId));
  });
  entries.command("create <title>")
    .requiredOption("--summary <summary>")
    .option("--body <markdown>")
    .option("--body-file <path>", "Markdown file, or - for stdin")
    .option("--went-live-at <date>", "ISO 8601 date and time", new Date().toISOString())
    .option("--release-url <url>")
    .addOption(new Option("--audience <audience>").choices(["everyone", "departments"]).default("everyone"))
    .addOption(new Option("--status <status>").choices(["draft", "published"]).default("draft"))
    .option("--department <department>", "department name or id (repeatable)", collect, [])
    .option("--label <label>", "label (repeatable)", collect, [])
    .option("--attach <path>", "attachment path (repeatable)", collect, [])
    .action(async (title: string, options: { summary: string; body?: string; bodyFile?: string; wentLiveAt: string; releaseUrl?: string; audience: "everyone" | "departments"; status: "draft" | "published"; department: string[]; label: string[]; attach: string[] }, command: Command) => {
      const scope = await projectScopeFor(runtime, command);
      const body = await textFromOptions(runtime.io, options.body, options.bodyFile, "body") ?? "";
      const departmentIds = await resolvedDepartments(runtime, scope, options.department);
      const entry = await createJourneyEntry(scope.context, scope.workspace.slug, scope.project!.id, { projectId: scope.project!.id, title, summary: options.summary, bodyMarkdown: body, wentLiveAt: parseDateTime(options.wentLiveAt), releaseUrl: options.releaseUrl, audience: options.audience, status: options.status, departmentIds, labels: labels(options.label) });
      const attachments = [];
      for (const path of options.attach) attachments.push(await uploadJourneyAttachment(scope.context, scope.workspace.slug, scope.project!.id, entry.id, await uploadedFile(path)));
      output(runtime, command).data({ ...entry, attachments });
    });
  entries.command("update <entry>")
    .option("--title <title>")
    .option("--summary <summary>")
    .option("--body <markdown>")
    .option("--body-file <path>", "Markdown file, or - for stdin")
    .option("--went-live-at <date>", "ISO 8601 date and time")
    .option("--release-url <url>")
    .option("--clear-release-url")
    .addOption(new Option("--audience <audience>").choices(["everyone", "departments"]))
    .option("--department <department>", "replace departments (repeatable)", collect)
    .option("--label <label>", "replace labels (repeatable)", collect)
    .option("--attach <path>", "attachment path (repeatable)", collect, [])
    .action(async (entryId: string, options: { title?: string; summary?: string; body?: string; bodyFile?: string; wentLiveAt?: string; releaseUrl?: string; clearReleaseUrl?: boolean; audience?: "everyone" | "departments"; department?: string[]; label?: string[]; attach: string[] }, command: Command) => {
      const scope = await projectScopeFor(runtime, command);
      const current = await runtime.resolveEntry(scope.context, scope.workspace, scope.project!, entryId);
      const body = await textFromOptions(runtime.io, options.body, options.bodyFile, "body");
      const departmentIds = await resolvedDepartments(runtime, scope, options.department);
      const entry = await updateJourneyEntry(scope.context, scope.workspace.slug, scope.project!.id, current.id, { title: options.title, summary: options.summary, bodyMarkdown: body, wentLiveAt: options.wentLiveAt ? parseDateTime(options.wentLiveAt) : undefined, releaseUrl: options.clearReleaseUrl ? null : options.releaseUrl, audience: options.audience, departmentIds, labels: labels(options.label) });
      const attachments = [];
      for (const path of options.attach) attachments.push(await uploadJourneyAttachment(scope.context, scope.workspace.slug, scope.project!.id, entry.id, await uploadedFile(path)));
      output(runtime, command).data({ ...entry, attachments });
    });
  for (const [name, published] of [["publish", true], ["unpublish", false]] as const) {
    entries.command(`${name} <entry>`).action(async (entryId: string, _options: unknown, command: Command) => {
      const scope = await projectScopeFor(runtime, command);
      const entry = await runtime.resolveEntry(scope.context, scope.workspace, scope.project!, entryId);
      output(runtime, command).data(await setJourneyEntryPublished(scope.context, scope.workspace.slug, scope.project!.id, entry.id, published));
    });
  }
  entries.command("delete <entry>").action(async (entryId: string, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    const entry = await runtime.resolveEntry(scope.context, scope.workspace, scope.project!, entryId);
    await confirmDestructive(runtime.io, `Delete ${entry.title}?`, Boolean(globals(command).yes));
    output(runtime, command).data(await deleteJourneyEntry(scope.context, scope.workspace.slug, scope.project!.id, entry.id));
  });

  const labelCommands = program.command("labels").description("Manage the current project's label catalog");
  labelCommands.command("list").action(async (_options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    output(runtime, command).data(await listProjectLabels(scope.context.api, scope.workspace.slug, scope.project!.id));
  });
  labelCommands.command("create <label>").action(async (label: string, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    output(runtime, command).data(await createJourneyLabel(scope.context, scope.workspace.slug, scope.project!.id, label));
  });
  labelCommands.command("rename <tag> <label>").action(async (tag: string, label: string, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    output(runtime, command).data(await renameJourneyLabel(scope.context, scope.workspace.slug, scope.project!.id, tag, label));
  });
  labelCommands.command("delete <tag>").action(async (tag: string, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    await confirmDestructive(runtime.io, `Delete label ${tag} and remove it from timeline entries?`, Boolean(globals(command).yes));
    output(runtime, command).data(await deleteJourneyLabel(scope.context, scope.workspace.slug, scope.project!.id, tag));
  });

  const attachments = program.command("attachments").description("Manage timeline entry attachments");
  attachments.command("list <entry>").action(async (entryId: string, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    const entry = await loadEntry(scope.context.api, scope.workspace.slug, scope.project!.id, entryId);
    output(runtime, command).data(entry.attachments);
  });
  attachments.command("add <entry> <path>").action(async (entryId: string, path: string, _options: unknown, command: Command) => {
    const scope = await projectScopeFor(runtime, command);
    const entry = await runtime.resolveEntry(scope.context, scope.workspace, scope.project!, entryId);
    output(runtime, command).data(await uploadJourneyAttachment(scope.context, scope.workspace.slug, scope.project!.id, entry.id, await uploadedFile(path)));
  });
  attachments.command("download <attachment>")
    .option("-o, --output <path>", "output file path")
    .option("--force", "overwrite an existing file")
    .action(async (attachmentId: string, options: { output?: string; force?: boolean }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const response = await scope.context.api.download(`/workspaces/${encodeURIComponent(scope.workspace.slug)}/attachments/${encodeURIComponent(attachmentId)}`);
      const destination = resolve(options.output ?? responseFileName(response, attachmentId));
      if (existsSync(destination) && !options.force) throw new CliError(`${destination} already exists; pass --force to overwrite it.`, "file_exists", 2);
      const bytes = await response.arrayBuffer();
      await writeFile(destination, Buffer.from(bytes));
      output(runtime, command).data({ path: destination, bytes: bytes.byteLength, attachmentId });
    });
  attachments.command("remove <attachment>").action(async (attachmentId: string, _options: unknown, command: Command) => {
    await confirmDestructive(runtime.io, "Delete this attachment?", Boolean(globals(command).yes));
    const scope = await runtime.scope(overrides(command), { project: "none" });
    output(runtime, command).data(await removeJourneyAttachment(scope.context, scope.workspace.slug, attachmentId));
  });

  const images = program.command("images").description("Manage issue images");
  images.command("list <issue>").action(async (issueKey: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
    output(runtime, command).data(await listIssueImages(scope.context.api, scope.workspace.slug, issue.id));
  });
  images.command("add <issue> <path>").action(async (issueKey: string, path: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
    output(runtime, command).data(await uploadJourneyIssueImage(scope.context, scope.workspace.slug, issue.id, await uploadedFile(path)));
  });
  images.command("download <image>")
    .option("-o, --output <path>", "output file path")
    .option("--force", "overwrite an existing file")
    .action(async (imageId: string, options: { output?: string; force?: boolean }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const response = await scope.context.api.download(`/workspaces/${encodeURIComponent(scope.workspace.slug)}/images/${encodeURIComponent(imageId)}`);
      const destination = resolve(options.output ?? responseFileName(response, imageId));
      if (existsSync(destination) && !options.force) throw new CliError(`${destination} already exists; pass --force to overwrite it.`, "file_exists", 2);
      const bytes = await response.arrayBuffer();
      await writeFile(destination, Buffer.from(bytes));
      output(runtime, command).data({ path: destination, bytes: bytes.byteLength, imageId });
    });
  images.command("remove <image>").action(async (imageId: string, _options: unknown, command: Command) => {
    await confirmDestructive(runtime.io, "Delete this image?", Boolean(globals(command).yes));
    const scope = await runtime.scope(overrides(command), { project: "none" });
    output(runtime, command).data(await removeJourneyIssueImage(scope.context, scope.workspace.slug, imageId));
  });

  const media = program.command("media").description("Manage issue description media");
  media.command("list <issue>").action(async (issueKey: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
    const detail = await loadIssue(scope.context.api, scope.workspace.slug, issue.project_id, issue.id);
    output(runtime, command).data(detail.attachments ?? []);
  });
  media.command("add <issue> <path>").action(async (issueKey: string, path: string, _options: unknown, command: Command) => {
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
    output(runtime, command).data(await uploadJourneyIssueAttachment(scope.context, scope.workspace.slug, issue.id, await uploadedFile(path)));
  });
  media.command("download <issue> <attachment>")
    .option("-o, --output <path>", "output file path")
    .option("--force", "overwrite an existing file")
    .action(async (issueKey: string, attachmentId: string, options: { output?: string; force?: boolean }, command: Command) => {
      const scope = await runtime.scope(overrides(command), { project: "none" });
      const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
      const response = await scope.context.api.download(`/workspaces/${encodeURIComponent(scope.workspace.slug)}/issues/${encodeURIComponent(issue.id)}/attachments/${encodeURIComponent(attachmentId)}`);
      const destination = resolve(options.output ?? responseFileName(response, attachmentId));
      if (existsSync(destination) && !options.force) throw new CliError(`${destination} already exists; pass --force to overwrite it.`, "file_exists", 2);
      const bytes = await response.arrayBuffer();
      await writeFile(destination, Buffer.from(bytes));
      output(runtime, command).data({ path: destination, bytes: bytes.byteLength, attachmentId });
    });
  media.command("remove <issue> <attachment>").action(async (issueKey: string, attachmentId: string, _options: unknown, command: Command) => {
    await confirmDestructive(runtime.io, "Remove this issue file?", Boolean(globals(command).yes));
    const scope = await runtime.scope(overrides(command), { project: "none" });
    const issue = await runtime.resolveIssue(scope.context, scope.workspace, issueKey);
    output(runtime, command).data(await removeJourneyIssueAttachment(scope.context, scope.workspace.slug, issue.id, attachmentId));
  });

  return program;
}
