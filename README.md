# @approve-so/cli

Command-line access to [Approve](https://approve.so) for people and local coding agents.

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

```sh
approve --json issues list --priority urgent
approve --json issues show APP-42
approve --json issues create "Handle refresh races" \
  --description-file issue.md \
  --priority high \
  --label Backend \
  --assignee @mohit
approve --json comments add APP-42 --body-file comment.md
approve --json issues update APP-42 --status Done
```

Long Markdown values accept either an inline flag such as `--description` or a corresponding file flag. Use `-` as the file name to read from standard input.

```sh
printf 'Reproduced on the latest build.\n' | approve --json comments add APP-42 --body-file -
```

## Management surface

Run `approve <group> --help` for command-specific flags. The groups are:

- `workspaces`, `projects`, and `project-roles`
- `statuses`, `issue-labels`, `departments`, `members`, and `invitations`
- `issues`, `comments`, and `images`
- `entries`, `labels`, and `attachments`

Issue labels are workspace-scoped and can be assigned to issues with repeated `--label` flags. Repeated labels on `issues list` match any selected label. On `issues update`, repeated `--label` values replace the full set and `--clear-labels` removes it. The separate `labels` group remains the project-scoped catalog for timeline entries.

Issue and timeline-entry deletion is soft deletion, matching the web product. Approve does not currently expose workspace or project deletion.

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
