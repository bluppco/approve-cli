# @approve-so/cli

Issue dependencies support both directions:

```sh
approve issues dependencies add APP-2 --blocked-by APP-1
approve issues dependencies add APP-1 --blocks APP-3
approve issues dependencies list APP-2 --json
approve issues dependencies remove APP-2 --blocked-by APP-1
```

Use `--cursor` on dependency lists to continue through `nextCursor` pages.
Both issues must be editable and in the same workspace. Adds/removals are
idempotent; circular dependencies are rejected. Issue lists show blocked state,
and issue details include linked issues with identifiers, titles, statuses, and assignees.

Command-line access to [Approve](https://approve.so) for people and local coding agents. See [Approve for agents](https://approve.so/agents) for the product overview or [the getting-started guide](https://approve.so/docs/getting-started) for the complete setup flow.

The CLI connects only to Approve's versioned REST API at `https://approve.so/api/v1`. The API runs in the existing Approve deployment and applies the same account, workspace membership, project-role, and server-enforced access rules as the web application. It does not require a separate API key.

## Install

Node.js 20 or newer is required.

```sh
npm install --global @approve-so/cli
approve --help
```

It can also be run without a global installation:

```sh
npx @approve-so/cli --help
```

## Sign in and choose defaults

A human signs in once through `approve.so`. The CLI opens a browser, prints a short code to verify, and polls only the branded Approve API. Passwords are never accepted by the terminal. Refresh credentials are saved in a user-only file under the operating system's standard configuration directory.

```sh
approve auth login
approve workspaces list
approve --workspace acme projects list
approve --workspace acme --project web context set
approve auth status
```

Saved context is global to the user account. Any command can override it with `--workspace` or `--project`.

`projects list` fetches projects in one API request using the workspace ID or slug,
without loading the profile or workspace details first. Expired sessions still
refresh automatically before the request is retried.

On a headless machine, print the URL without trying to launch a browser:

```sh
approve auth login --no-browser
```

```sh
approve issues list
approve --project api issues list
approve context clear
approve auth logout
```

For isolated development or tests, `APPROVE_CONFIG_DIR` changes where credentials and defaults are stored. `APPROVE_API_URL` may point a development build at a local or staging Approve API; production defaults to `https://approve.so/api/v1`.

## Common agent workflows

Human-readable tables are the default. Pass `--json` when another program or agent will consume the result.

The machine-output contract, safety flags, and exit-code guidance are documented at [approve.so/docs/automation](https://approve.so/docs/automation). The complete browser reference is available at [approve.so/docs/cli](https://approve.so/docs/cli).

```sh
approve --json issues list --priority urgent
approve --json issues show APP-42
approve --json issues create "Handle refresh races" \
  --description-file issue.md \
  --priority high \
  --label Backend \
  --assignee @mohit
approve --json comments add APP-42 --body-file comment.md
approve --json comments add APP-42 --attach repro.mp4
approve --json issues update APP-42 --status Done
approve --json issues update APP-42 --attach walkthrough.webm
```

Long Markdown values accept either an inline flag such as `--description` or a corresponding file flag. Use `-` as the file name to read from standard input.

```sh
printf 'Reproduced on the latest build.\n' | approve --json comments add APP-42 --body-file -
```

## Management surface

Run `approve <group> --help` for command-specific flags. The groups are:

- `workspaces`, `projects`, and `project-roles`
- `statuses`, `issue-labels`, `departments`, `members`, and `invitations`
- `issues`, `comments`, `images`, and issue `media`
- `documents`, `entries`, `labels`, `attachments`, and `notifications`

Issue labels are workspace-scoped and can be assigned to issues with repeated `--label` flags. Repeated labels on `issues list` match any selected label. On `issues update`, repeated `--label` values replace the full set and `--clear-labels` removes it. The separate `labels` group remains the project-scoped catalog for timeline entries.

Issue and timeline-entry deletion is soft deletion, matching the web product. Approve does not currently expose workspace or project deletion.

Issue descriptions and comments accept repeated `--attach` flags for JPEG, PNG, WebP, GIF, AVIF, PDF, MP4, WebM, MOV, M4V, and OGV files up to 25 MB each. Use `approve media` to list, add, download, or remove issue-description media. The legacy `--image` and `images` commands remain available.

Destructive commands prompt when attached to a terminal. Agents and other non-interactive callers must explicitly pass `--yes`:

```sh
approve --json --yes issues delete APP-42
```

Downloads refuse to overwrite an existing path unless `--force` is supplied.

## Output and exit codes

Successful JSON output uses a stable envelope:

```json
{"data": {"id": "..."}}
```

List commands may additionally include `meta`. JSON errors are written to standard error:

```json
{"error": {"code": "forbidden", "message": "Permission denied."}}
```

Exit codes are:

- `0` success
- `1` backend or unexpected failure
- `2` command usage or validation failure
- `3` authentication required
- `4` permission denied
- `5` resource not found
- `6` conflicting current data

Successful data is written to stdout. Prompts, warnings, and failures use stderr so JSON can be piped safely.

## Development

This package intentionally lives beside, not inside, the Astro application. It contains its own HTTP client and imports no Astro source or private platform SDK. The build fails if a private upstream hostname, SDK import, or Astro source path is ever included in a publishable artifact.

```sh
bun install
bun run test
bun run check
bun run build
npm pack --dry-run
```

Before starting a build or test, make sure another matching command is not already running for this package.

## Project documents

Documents are internal to workspace members with project access, even when a project's timeline is public. Project editors/owners and workspace admins/owners can write them. Each document has a title (1–120 characters) and a Markdown body (up to 50,000 characters), with no attachments.

```sh
approve --json documents list --limit 50
approve --json documents show "Project brief"
approve --json documents create "Project brief" --body-file brief.md
approve --json documents update DOCUMENT_ID --body-file -
approve --json --yes documents delete DOCUMENT_ID
```

Lists omit document bodies and return `meta.nextCursor`; pass it to `documents list --cursor`. Commands resolve IDs or exact titles across all pages. Duplicate titles require an ID. Use `--body ""` to clear a body. Updates follow the web app's best-effort conflict behavior: simultaneous saves may overwrite each other. Revision history and native iOS document screens are not included.


### Project sharing defaults

Omit project scope to inherit the workspace's creation default (Restricted unless a workspace owner/admin changes it). Explicit scopes are `restricted`, `workspace`, and `public`; `departments` remains a compatible alias for restricted access. Restricted projects can have selected departments or individual viewer/editor/owner grants, including no departments. Viewers and audience-based readers cannot comment or edit. Workspace owners/admins retain full access. Existing projects keep their audience, and project updates preserve omitted sharing settings.

Create a sub-issue in the selected project with
`approve issues create "Implement validation" --parent ACME-12`.
`approve issues show ACME-12` includes its parent and first page of children;
use `--sub-issues-cursor <cursor>` with the returned `subIssuesNextCursor` for more.

## Notifications

Use `approve --workspace acme notifications list --state unread` to inspect your
inbox. Follow `data.nextCursor` with `--cursor` for more pages.

```sh
approve --workspace acme notifications read <id>
approve --workspace acme notifications read <id> --unread
approve --workspace acme notifications read-all
approve --workspace acme notifications delete <id>
approve --workspace acme notifications delete-all --read
approve --workspace acme notifications delete-all
```

Deletion requires confirmation, or `--yes` for noninteractive use. Bulk actions
operate on the signed-in user's current notifications in that workspace and
preserve later arrivals. They are not transactional; inspect the inbox after a
partial failure before retrying.

## Project link resources

Projects have a Resources tab for website, GitHub, and other HTTP(S) links. Each link has a required absolute URL and an optional name (up to 120 characters). Unnamed links display the URL. Resources are internal to workspace members who can read the project, including when its timeline is public. Editors, owners, and workspace administrators can add, edit, and remove links.

```sh
approve --workspace acme --project web resources list
approve resources create https://github.com/team/repo --name "GitHub repository"
approve resources show "GitHub repository"
approve resources update RESOURCE_ID --url https://example.com --name ""
approve --yes resources delete RESOURCE_ID
```

Use `--json` for machine output and `--limit`/`--cursor` for pagination (`meta.nextCursor`). Resolve by ID or exact name; duplicate names require an ID. Clearing the name uses `--name ""`. Duplicate URLs are allowed. Removal soft-deletes the resource. Link previews and public publishing are not included.
