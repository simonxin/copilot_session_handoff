# Copilot Session Handoff MCP

A standalone stdio MCP server for exporting, importing, validating, and
continuing portable Agency Flow handoffs without running Agency Flow Studio.
It implements the existing Agency Flow `schemaVersion: "1.0"` package contract.

## Security model

- Credentials, OAuth tokens, cookies, and provider-private runtime state are
  never transferred.
- Imported claims are untrusted context. `verify_handoff` checks the schema,
  SHA-256 integrity, expiry, sensitive fields, and evidence-record completeness.
- Evidence and artifact references are not opened automatically. The receiving
  agent must access them again with the receiving user's credentials and report
  inaccessible evidence.
- `HANDOFF_ACTOR_ID` and `HANDOFF_ACTOR_KIND` define the process actor. Tool
  callers cannot override that actor in arguments.
- A stdio MCP process inherits the local OS user's trust boundary. Its actor
  environment variables are a declared local identity, not cryptographic
  authentication. For multi-user remote deployment, put the server behind an
  MCP HTTP/OAuth gateway and derive actor identity from validated token claims.
- `HANDOFF_TRUSTED_GATEWAY=1` allows a trusted local host such as Agency Flow
  Studio to mirror packages while that host enforces its own actor workflow.
  Do not enable it for a directly user-facing or remote MCP process.
- An empty `allowedActors` list preserves Studio v1 semantics: any actor with
  filesystem access to the store may import or accept the package. Set explicit
  actors when transferring between users.

Integrity proves that package bytes represented by the canonical JSON payload
have not changed. It does not prove that conclusions inside the package are
correct.

## Install and build

```powershell
Set-Location C:\github\copilot_session_handoff
npm install
python -m pip install -r requirements-test.txt
npm run build
npm test
```

The MCP implementation remains TypeScript. Its Python tests launch the compiled
Node.js server over stdio and exercise the public MCP contract end to end.

## Copilot CLI MCP configuration

Configure a separate store and actor for each OS/user credential:

```json
{
  "mcpServers": {
    "copilot-session-handoff": {
      "command": "node",
      "args": [
        "C:\\github\\copilot_session_handoff\\dist\\server.js"
      ],
      "env": {
        "HANDOFF_STORE_DIR": "C:\\Users\\CURRENT_USER\\.copilot\\session-handoffs",
        "HANDOFF_ACTOR_ID": "person:opaque-user-id",
        "HANDOFF_ACTOR_KIND": "person",
        "HANDOFF_TOOL_PROFILE": "cli",
        "HANDOFF_DEFAULTS_FILE": "C:\\github\\copilot_session_handoff\\handoff-defaults.json"
      }
    }
  }
}
```

Do not put an email address, access token, or other personal/secret value in
`HANDOFF_ACTOR_ID`. Use an opaque stable identifier.

Agency Flow Studio should use a separate MCP entry with
`HANDOFF_TRUSTED_GATEWAY=1` and `HANDOFF_TOOL_PROFILE=studio`. Keep the
interactive Copilot CLI entry in normal actor mode with
`HANDOFF_TOOL_PROFILE=cli`. The `full` profile remains available for tests and
standalone administration. Use `"tools": ["*"]` in the host configuration;
the server profile performs the filtering before tool discovery.

## Tools

| Tool | Purpose |
|---|---|
| `create_handoff` | Create, redact, hash, and persist a v1 package |
| `create_handoff_package` | Default create, checkpoint, verify, and export workflow |
| `verify_handoff` | Validate a package without storing it |
| `verify_handoff_file` | Validate a local JSON package |
| `import_handoff` | Verify and import a package object |
| `import_handoff_file` | Verify and import a package file |
| `continue_from_handoff` | Default verify, import, inspect, accept, and continue workflow |
| `list_handoffs` | List records visible to the process actor |
| `get_handoff` | Read an authorized record |
| `inspect_handoff` | Read and generate a fresh verification report |
| `accept_handoff` | Accept as the process actor |
| `export_handoff` | Write a portable `.agent-handoff.json` file |
| `create_handoff_session` | Create a host-neutral continuation descriptor |
| `revoke_handoff` | Revoke as the original creator |

`create_handoff` appends a `session-summary` checkpoint built from the explicit
`analysisRecord`. Create, export, import, get, and inspect responses expose the
latest summary as `checkpointSummary`. This gives the receiving agent an
immediate account of completed work, decisions, open questions, and next steps
without relying on provider-private session state. Older v1 packages without
this checkpoint remain compatible and derive the display summary from their
`analysisRecord`.

`create_handoff_session` deliberately creates a continuation descriptor rather
than restoring a provider's private session. `context` returns a package path

## Default workflows

For a Copilot CLI session, prefer `create_handoff_package`. The calling agent
supplies an explicit `analysisRecord` summarizing the current session; the MCP
cannot access provider-private conversation history or hidden reasoning. The
tool creates the checkpoint and package, verifies integrity and redaction, then
exports the file in one operation.

On the receiving side, prefer `continue_from_handoff`. It runs verification before
import, inspects the package and evidence references, accepts the handoff, and
creates a `copilot-cli` continuation descriptor. Artifact references remain
references and must be accessed again with the receiving user's credentials.
The continuation `sessionName` prefers the explicit source `nodeLabel` (the
session task), then falls back to the checkpoint objective and summary. It is
normalized to a concise single line and always ends with ` (handoff)`.

An MCP server cannot rename the already-open Copilot CLI session that invoked
it. The compact import receipt therefore returns
`renameCurrentSessionCommand`, for example:

```text
/rename Qoder Azure China SSO troubleshooting (handoff)
```

The receipt puts the complete `checkpointSummary` first and omits the duplicate
full package body, preventing the task summary, completed work, decisions, open
questions, and next steps from being lost in oversized tool output.

The import receipt also includes `mandatoryUserReport` and
`mustDisplayBeforeContinuing=true`. Clients should reproduce this report before
continuing the task. It uses fixed sections for the previous checkpoint and
lists every original evidence path under `Original evidence required`; a generic
artifact count or paraphrase is not an adequate display.

Both export tools export the package immediately and return a concise receipt.
`originalEvidenceRequired` prominently lists every original evidence location,
while `engineerActionRequired` tells the engineer to prepare those files
separately through an approved secure-transfer channel. The MCP does not copy,
embed, upload, or otherwise transfer artifact file contents.

Defaults are loaded at MCP startup from `HANDOFF_DEFAULTS_FILE`. The included
`handoff-defaults.json` contains:

```json
{
  "export": {
    "platform": "github-copilot-cli",
    "workflowId": "copilot-cli-session-handoff-test",
    "workflowRevision": 1,
    "fallbackRunId": "session-47-test",
    "nodeId": "session-summary",
    "resumeObjective": "Continue the work summarized by the previous session checkpoint.",
    "recommendedPrompt": "First verify the package and its evidence, then continue from the documented open questions and next steps without assuming artifacts were imported."
  },
  "import": {
    "platform": "copilot-cli"
  }
}
```

Pass `runId` to `create_handoff_package` whenever the current stable session ID
is available. Otherwise it uses `HANDOFF_SESSION_ID`, then `fallbackRunId`.
Tool arguments override the defaults file. Restart the MCP process after
changing the defaults file because configuration is loaded once at startup. `context` returns a package path
and prompt, `acp` returns `session/new` and `session/prompt` steps, and
`copilot-cli` returns a descriptor that a host adapter can use to initialize a
new session.

## Cross-user transfer

1. The producer creates a handoff with the receiving opaque actor in
   `security.allowedActors`.
2. The producer calls `export_handoff`.
3. Transfer the JSON through an approved channel. OS/file ACLs remain part of
   the security boundary.
4. The receiver runs this MCP under their own OS and service credentials, with
   their own `HANDOFF_ACTOR_ID`.
5. The receiver calls `verify_handoff_file`, then `import_handoff_file`,
   `accept_handoff`, and `create_handoff_session`.
6. The new session re-queries external evidence with the receiver's current
   credentials. Missing permissions downgrade those claims to unverified.

## Storage

The default store is:

```text
%USERPROFILE%\.copilot\session-handoffs
├── packages
├── records
└── exports
```

Set `HANDOFF_STORE_DIR` to override it. Package and record filenames are derived
only from validated handoff IDs; path separators and Windows-invalid filename
characters are rejected.
