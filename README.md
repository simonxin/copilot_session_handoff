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

## Install as a Copilot CLI plugin

Register the GitHub repository as a marketplace and install the plugin:

```powershell
copilot plugin marketplace add simonxin/copilot_session_handoff
copilot plugin install copilot-session-handoff@simonxin-plugins
```

If GitHub access from Copilot CLI is unavailable, clone through any approved
network path, register the local checkout as the marketplace, and install from
it:

```powershell
git clone https://github.com/simonxin/copilot_session_handoff.git C:\tools\copilot-session-handoff
copilot plugin marketplace add C:\tools\copilot-session-handoff
copilot plugin install copilot-session-handoff@simonxin-plugins
```

The repository includes a bundled `plugin-dist/server.mjs`, so the target
machine does not need to run `npm install` or compile TypeScript. Node.js 20 or
newer is still required. The plugin stores packages in the MCP's normal default
location:

```text
%USERPROFILE%\.copilot\session-handoffs
```

The plugin uses the built-in workflow defaults. `HANDOFF_DEFAULTS_FILE` remains
available for manual MCP configurations, but is intentionally omitted from the
plugin manifest because Copilot CLI does not expand `${PLUGIN_ROOT}` inside MCP
environment-variable values.

Verify the installation:

```powershell
copilot plugin list
copilot mcp list
```

Update the marketplace metadata first, then update the installed plugin:

```powershell
copilot plugin marketplace update simonxin-plugins
copilot plugin update copilot-session-handoff
```

## Copilot CLI MCP configuration

Manual MCP configuration remains available when plugin installation is not
desired. Configure a separate store and actor for each OS/user credential:

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
| `export_session_handoff` | Export a ZIP with the handoff plus reviewed session and evidence files |
| `verify_handoff` | Validate a package without storing it |
| `verify_handoff_file` | Validate a local JSON package |
| `import_handoff` | Verify and import a package object |
| `import_handoff_file` | Verify and import a package file |
| `continue_from_handoff` | Default verify, import, inspect, accept, and continue workflow |
| `continue_from_handoff_bundle` | Verify, extract, import, and continue from a ZIP bundle |
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

Long sessions can also supply `milestones` to `create_handoff` or
`create_handoff_package`. The MCP assigns each milestone a stable ID and
timestamp, stores the milestones before the final `session-summary`, and
returns both `milestoneCheckpoints` and `findingEvidenceMap`.

Each milestone can contain structured findings. A finding associates its
conclusion with stable IDs declared on `content.evidence` or `artifacts`:

```json
{
  "evidence": [
    {
      "id": "evidence-query-result",
      "description": "Validated query output"
    }
  ],
  "artifacts": [
    {
      "id": "evidence-auth-har",
      "path": "C:\\case\\authentication.har"
    }
  ],
  "milestones": [
    {
      "title": "Evidence collection",
      "phase": "investigation",
      "summary": "Collected and reviewed the authentication evidence.",
      "findings": [
        {
          "id": "finding-auth-failure",
          "statement": "The callback request was rejected.",
          "status": "confirmed",
          "confidence": "high",
          "evidenceIds": ["evidence-auth-har"]
        }
      ]
    }
  ]
}
```

`confirmed` and `supported` findings must reference at least one declared
evidence ID. Duplicate evidence IDs, duplicate finding IDs, duplicate links,
and undeclared evidence references make verification fail. `hypothesis` and
`unverified` findings may omit evidence, but verification reports a warning.
The import report includes a compact milestone timeline showing every finding
and its evidence IDs; the full structured checkpoints remain in the package.
Because milestones use the existing generic `content.checkpoints` extension
point, Studio and older v1 readers remain compatible and can ignore checkpoint
kinds they do not understand.

`create_handoff_session` deliberately creates a continuation descriptor rather
than restoring a provider's private session. `context` returns a package path

## Default workflows

For a Copilot CLI session, the default export format is `bundle`. Use
`export_session_handoff` for normal handoffs. The calling agent supplies an
explicit `analysisRecord` because the MCP cannot access provider-private
conversation history or hidden reasoning. The tool creates the checkpoint and
package, adds only the explicitly reviewed session and evidence files, verifies
integrity, and writes one `.handoff-bundle.zip`.

The normal CLI plugin profile exposes only `export_session_handoff` and
`continue_from_handoff`, so the agent cannot accidentally select the old JSON
export. `create_handoff_package` remains available in the `full` administrative
profile as a metadata-only fallback.

### Prompt samples

Export the current session as a ZIP bundle:

```text
Export the current Copilot session as a handoff ZIP bundle to C:\case\handoffs.
Include the safe session history, but do not include original evidence files.
```

Export the session with reviewed evidence files:

```text
Export the current session as a handoff ZIP bundle to C:\case\handoffs.
Include the safe session history and these original evidence files:
- C:\case\authentication.har
- C:\case\diagnostic.log

I have reviewed these files for credentials, tokens, cookies, personal data,
and other sensitive content, and I approve including them in the bundle.
Report the exact ZIP path and the evidence file names that were included.
```

For a long investigation, ask Copilot to preserve milestone checkpoints and
finding-to-evidence relationships:

```text
Create a handoff ZIP for this investigation. Summarize the major milestones,
confirmed findings, decisions, open questions, and next steps. Associate every
confirmed finding with the relevant evidence file or query result, and include
the reviewed original evidence files in the bundle.
```

Continue from a received bundle:

```text
Continue from C:\case\handoff-<id>.handoff-bundle.zip. Verify the bundle,
checksums, package integrity, and evidence manifest before using its contents.
Show the previous checkpoint, milestone timeline, original evidence, open
questions, and next steps before continuing the work.
```

Only request original file inclusion after reviewing the files. A handoff ZIP
provides integrity checks but is not encrypted; transfer it through an approved
secure channel.

On the receiving side, use `continue_from_handoff` for both formats. It detects
ZIP input from its file signature and applies bundle verification and isolated
extraction automatically; non-ZIP input follows the JSON package workflow. It
then accepts the handoff and creates a `copilot-cli` continuation descriptor.
Metadata-only artifact references must still be accessed again with the
receiving user's credentials.
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

The metadata-only export tools export the package immediately and return a
concise receipt.
`originalEvidenceRequired` prominently lists every original evidence location,
while `engineerActionRequired` tells the engineer to prepare those files
separately through an approved secure-transfer channel. The MCP does not copy,
embed, upload, or otherwise transfer artifact file contents.

## Portable handoff bundles

`export_session_handoff` is the default workflow for cases where the
receiving engineer needs the structured handoff, a reviewed high-fidelity
session export, an optional CLI `/share` file, and original evidence in one
portable ZIP. The metadata-only JSON workflow remains available as a fallback
when file contents cannot be included.

The caller must set both `includeFileContents=true` and
`sensitivityReviewConfirmed=true`. When `sessionHistoryFile` is omitted, the
MCP uses `runId` to read
`%USERPROFILE%\.copilot\session-state\<runId>\events.jsonl` and generates an
allowlisted `safe-session-events.json`. It excludes all `system.*`, `model.*`,
and `hook.*` events and removes fields such as `reasoningOpaque`,
`encryptedContent`, and `toolTelemetry`.

Every local `artifacts[].path` is automatically included under `evidence/`;
callers do not need to repeat those files in `evidenceFiles`. Non-file artifact
references remain metadata-only. Directories and symlinks are rejected. Each
file is limited to 100 MiB, the uncompressed bundle content is limited to
250 MiB, and an archive may contain at most 100 entries.

If a repeated export omits `artifacts` and `evidenceFiles`, the MCP recovers
existing evidence files that were explicitly supplied to an earlier handoff
export call in the same Copilot session. The receipt lists these under
`autoDiscoveredEvidence`. Explicit paths still take precedence.

The plugin also includes the `session-handoff-export` skill. It directs Copilot
to load the deferred MCP tool before use, forbids unsupported "0 tools" claims,
and requires the agent to verify that evidence entries exist before reporting a
successful evidence-inclusive export.

```text
handoff-<id>.handoff-bundle.zip
├── manifest.json
├── handoff.agent-handoff.json
├── checksums.sha256
├── session/
│   ├── <id>-safe-session-events.json
│   └── <id>-session-share.md
└── evidence/
    └── <id>-authentication.har
```

The embedded handoff uses `bundle://` artifact URIs rather than exposing source
machine paths. `manifest.json` records every file's role, media type, size, and
SHA-256 hash. `continue_from_handoff_bundle` validates archive paths, duplicate
entries, entry and expanded sizes, manifest uniqueness, checksums, the embedded
handoff schema and integrity, actor authorization, and manifest-to-artifact
associations before extracting files under:

```text
%USERPROFILE%\.copilot\session-handoffs\bundles\<bundle-id>
```

Bundled files remain untrusted evidence after extraction. The receiving
engineer must inspect and revalidate them and must not execute bundle contents.
The ZIP provides packaging and integrity checks, not encryption or sender
authenticity. Transfer it only through an approved case attachment or
access-controlled secure channel.

Do not add raw `session.db`, unfiltered `events.jsonl`, hidden reasoning, system
instructions, provider-private state, credentials, cookies, or tokens. Generate
and review a safe high-fidelity session JSON first, then supply that file using
`sessionHistoryFile`. A CLI `/share` Markdown or HTML export can be supplied
separately using `sessionShareFile`.

Defaults are loaded at MCP startup from `HANDOFF_DEFAULTS_FILE`. The included
`handoff-defaults.json` contains:

```json
{
  "export": {
    "format": "bundle",
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
