---
name: session-handoff-export
description: Export or back up a Copilot CLI session as a handoff ZIP bundle, including original evidence files. Use for session handoff, session package export, backup, ZIP bundle, or requests mentioning export_session_handoff.
---

When the user asks to export, back up, or hand off the current session:

1. Load the deferred MCP tool named
   `copilot-session-handoff-export_session_handoff` through tool search before
   attempting the export.
2. Do not state that the MCP or tool is unavailable unless an actual tool
   search or tool invocation returned that error in the current turn. The
   absence of a directly loaded tool definition means you must search for it.
3. Call `export_session_handoff`; never substitute a metadata-only JSON export.
4. Set `runId` to the current Copilot session ID, use the requested destination
   and overwrite setting, and set both `includeFileContents` and
   `sensitivityReviewConfirmed` to `true` only when the user explicitly asks to
   include evidence files.
5. Pass every known original evidence path in `artifacts`. Include a concise
   description and media type when known. The MCP also recovers evidence paths
   from earlier handoff export calls in the same session, but explicit paths
   remain preferred.
6. After the call, check `manifest.entries` or `includedFiles`. If evidence was
   requested, do not report success unless at least one entry has role
   `evidence`. Report the exact ZIP path and the evidence file names included.
