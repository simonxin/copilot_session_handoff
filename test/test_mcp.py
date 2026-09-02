import json
import zipfile
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from conftest import EXPECTED_TOOLS, McpProcess


def test_standalone_mcp_lifecycle(mcp: McpProcess) -> None:
    assert mcp.list_tools() == EXPECTED_TOOLS

    handoff = create_handoff(
        mcp,
        state_snapshot={"password": "must-not-export"},
        allowed_actors=[{"id": "person:receiver", "kind": "person"}],
    )
    package = handoff["package"]
    assert package["createdBy"]["id"] == "person:receiver"
    assert package["content"]["stateSnapshot"]["password"] == "[REDACTED]"
    checkpoint = package["content"]["checkpoints"][-1]
    assert checkpoint["kind"] == "session-summary"
    assert checkpoint["summary"] == "Continue this task."

    inspected = mcp.call_tool(
        "inspect_handoff",
        {"handoffId": package["handoffId"]},
    )
    assert inspected["verification"]["valid"] is True

    mcp.call_tool("accept_handoff", {"handoffId": package["handoffId"]})
    materialized = mcp.call_tool(
        "create_handoff_session",
        {"handoffId": package["handoffId"], "platform": "context"},
    )
    assert materialized["handoff"]["status"] == "materialized"
    target_session = materialized["handoff"]["targetSessions"][0]
    assert target_session["sessionName"] == "Continue this task. (handoff)"
    assert (
        target_session["launchDescriptor"]["sessionName"]
        == "Continue this task. (handoff)"
    )
    prompt = target_session["launchDescriptor"]["prompt"]
    assert "current user credential" in prompt
    assert "Checkpoint from the previous session" in prompt
    assert "Continue this task." in prompt

    exported = mcp.call_tool(
        "export_handoff",
        {"handoffId": package["handoffId"]},
    )
    assert exported["filePath"].endswith(".agent-handoff.json")
    assert Path(exported["filePath"]).is_file()
    assert exported["checkpointSummary"] == checkpoint
    assert exported["evidenceTransferPreparation"] == {
        "required": False,
        "packageContainsArtifactContents": False,
        "files": [],
        "message": "No original evidence files were declared for this handoff.",
    }
    assert exported["originalEvidenceRequired"] == []


def test_tool_profiles_expose_only_host_specific_tools(tmp_path: Path) -> None:
    cli = McpProcess(
        tmp_path / "cli-store",
        {"HANDOFF_TOOL_PROFILE": "cli"},
    )
    studio = McpProcess(
        tmp_path / "studio-store",
        {"HANDOFF_TOOL_PROFILE": "studio"},
    )
    try:
        assert cli.list_tools() == {
            "export_session_handoff",
            "continue_from_handoff",
        }
        assert studio.list_tools() == {
            "verify_handoff",
            "import_handoff",
            "get_handoff",
        }
    finally:
        cli.close()
        studio.close()


def test_plugin_manifest_launches_bundled_mcp(tmp_path: Path) -> None:
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / ".mcp.json").read_text(encoding="utf-8"))
    configuration = manifest["mcpServers"]["copilot-session-handoff"]
    assert "HANDOFF_DEFAULTS_FILE" not in configuration["env"]
    server = Path(
        configuration["args"][0].replace("${PLUGIN_ROOT}", str(root))
    )

    plugin = McpProcess(
        tmp_path / "plugin-store",
        configuration["env"],
        server=server,
    )
    try:
        assert plugin.list_tools() == {
            "export_session_handoff",
            "continue_from_handoff",
        }
    finally:
        plugin.close()


def test_creates_and_verifies_studio_compatible_package(mcp: McpProcess) -> None:
    package = create_handoff(mcp)["package"]

    verification = mcp.call_tool("verify_handoff", {"package": package})

    assert verification["verification"]["valid"] is True
    assert verification["verification"]["integrityValid"] is True
    assert len(verification["verification"]["warnings"]) == 1


def test_import_returns_previous_session_checkpoint(
    mcp: McpProcess,
    tmp_path: Path,
) -> None:
    package = create_handoff(
        mcp,
        observations=["Inspected the document", "Validated the extracted data"],
        decisions=["Use the verified table as the source of truth"],
        next_steps=["Continue with the remaining pages"],
    )["package"]
    package_path = tmp_path / "handoff.agent-handoff.json"
    package_path.write_text(
        json.dumps(package),
        encoding="utf-8",
    )
    receiver = McpProcess(tmp_path / "receiver-store")
    try:
        imported = receiver.call_tool(
            "import_handoff_file",
            {"filePath": str(package_path)},
        )
    finally:
        receiver.close()

    checkpoint = imported["checkpointSummary"]
    assert checkpoint["summary"] == "Continue this task."
    assert checkpoint["completedWork"] == [
        "Inspected the document",
        "Validated the extracted data",
    ]
    assert checkpoint["decisions"] == [
        "Use the verified table as the source of truth"
    ]
    assert checkpoint["nextSteps"] == ["Continue with the remaining pages"]


def test_default_export_and_resume_workflows(tmp_path: Path) -> None:
    defaults_path = tmp_path / "defaults.json"
    defaults_path.write_text(
        json.dumps(
            {
                "export": {
                    "platform": "github-copilot-cli",
                    "workflowId": "custom-workflow",
                    "workflowRevision": 2,
                    "fallbackRunId": "custom-fallback-session",
                    "nodeId": "custom-summary",
                    "resumeObjective": "Continue the verified session work.",
                    "recommendedPrompt": "Verify evidence, then continue.",
                },
                "import": {"platform": "copilot-cli"},
            }
        ),
        encoding="utf-8",
    )
    producer = McpProcess(
        tmp_path / "producer-store",
        {"HANDOFF_DEFAULTS_FILE": str(defaults_path)},
    )
    try:
        export_arguments = {
            "analysisRecord": {
                "summary": "Analyzed the previous session.",
                "observations": ["Collected explicit session results."],
                "decisions": ["Use the handoff checkpoint."],
                "openQuestions": ["Revalidate the referenced evidence."],
                "nextSteps": ["Continue the remaining analysis."],
            },
            "artifacts": [
                {
                    "path": r"C:\case\evidence.har",
                    "description": "Authentication trace",
                    "contentHash": "a" * 64,
                    "mediaType": "application/json",
                }
            ],
        }
        exported = producer.call_tool(
            "create_handoff_package",
            export_arguments,
        )
    finally:
        producer.close()

    assert exported["handoffId"].startswith("handoff-")
    assert exported["verification"]["valid"] is True
    assert Path(exported["filePath"]).is_file()
    assert exported["defaultsUsed"]["workflowId"] == "custom-workflow"
    assert exported["defaultsUsed"]["format"] == "bundle"
    assert exported["exportFormat"] == "json"
    transfer = exported["evidenceTransferPreparation"]
    assert transfer["required"] is True
    assert transfer["packageContainsArtifactContents"] is False
    assert transfer["files"] == [
        {
            "index": 1,
            "reference": r"C:\case\evidence.har",
            "description": "Authentication trace",
            "contentHash": "a" * 64,
            "mediaType": "application/json",
        }
    ]
    assert "approved case attachment" in " ".join(transfer["instructions"])
    assert exported["originalEvidenceRequired"] == [
        {
            "location": r"C:\case\evidence.har",
            "description": "Authentication trace",
            "contentHash": "a" * 64,
            "mediaType": "application/json",
        }
    ]
    assert "not contained" in exported["engineerActionRequired"]

    receiver = McpProcess(
        tmp_path / "receiver-store",
        {"HANDOFF_DEFAULTS_FILE": str(defaults_path)},
    )
    try:
        resumed = receiver.call_tool(
            "continue_from_handoff",
            {"filePath": exported["filePath"]},
        )
    finally:
        receiver.close()

    assert resumed["verification"]["valid"] is True
    assert resumed["status"] == "materialized"
    assert resumed["continuation"]["platform"] == "copilot-cli"
    assert (
        resumed["continuation"]["sessionName"]
        == "Continue the verified session work. (handoff)"
    )
    assert (
        resumed["renameCurrentSessionCommand"]
        == "/rename Continue the verified session work. (handoff)"
    )
    assert resumed["currentSessionRenameRequired"] is True
    assert resumed["mustDisplayBeforeContinuing"] is True
    assert resumed["checkpointSummary"] == {
        "kind": "session-summary",
        "id": resumed["checkpointSummary"]["id"],
        "timestamp": resumed["checkpointSummary"]["timestamp"],
        "title": "Session handoff summary",
        "summary": "Analyzed the previous session.",
        "completedWork": ["Collected explicit session results."],
        "decisions": ["Use the handoff checkpoint."],
        "openQuestions": ["Revalidate the referenced evidence."],
        "nextSteps": ["Continue the remaining analysis."],
        "objective": "Continue the verified session work.",
    }
    assert "package" not in resumed["inspection"]
    report = resumed["mandatoryUserReport"]
    assert "## Previous session checkpoint" in report
    assert "**Completed work:**" in report
    assert "- Collected explicit session results." in report
    assert "**Decisions:**" in report
    assert "## Original evidence required" in report
    assert r"`C:\case\evidence.har`" in report
    assert "**Engineer action:**" in report
    assert resumed["originalEvidenceRequired"] == [
        {
            "location": r"C:\case\evidence.har",
            "description": "Authentication trace",
            "contentHash": "a" * 64,
            "mediaType": "application/json",
        }
    ]
    assert resumed["inspection"]["resumeInstructions"] == {
        "objective": "Continue the verified session work.",
        "recommendedPrompt": "Verify evidence, then continue.",
    }
    assert "not imported" in resumed["artifactNotice"]


def test_milestone_checkpoints_link_findings_to_evidence(
    tmp_path: Path,
) -> None:
    producer = McpProcess(
        tmp_path / "milestone-producer",
        {"HANDOFF_TOOL_PROFILE": "full"},
    )
    try:
        exported = producer.call_tool(
            "create_handoff_package",
            {
                "analysisRecord": {
                    "summary": "Completed a multi-stage investigation.",
                    "observations": ["Validated the final implementation."],
                    "decisions": ["Use structured milestone checkpoints."],
                    "nextSteps": ["Revalidate evidence after import."],
                },
                "evidence": [
                    {
                        "id": "evidence-query-result",
                        "type": "query-result",
                        "description": "Validated query output",
                    }
                ],
                "artifacts": [
                    {
                        "id": "evidence-auth-har",
                        "path": r"C:\case\authentication.har",
                        "description": "Authentication network trace",
                    }
                ],
                "milestones": [
                    {
                        "title": "Evidence collection",
                        "phase": "investigation",
                        "summary": "Collected the authentication evidence.",
                        "completedWork": ["Captured and reviewed the HAR."],
                        "findings": [
                            {
                                "id": "finding-auth-failure",
                                "statement": "The callback request was rejected.",
                                "status": "confirmed",
                                "confidence": "high",
                                "evidenceIds": ["evidence-auth-har"],
                            }
                        ],
                    },
                    {
                        "title": "Implementation validation",
                        "phase": "validation",
                        "summary": "Validated the corrected behavior.",
                        "completedWork": ["Ran the verification query."],
                        "findings": [
                            {
                                "id": "finding-fix-validated",
                                "statement": "The corrected flow completed.",
                                "status": "supported",
                                "evidenceIds": ["evidence-query-result"],
                            }
                        ],
                    },
                ],
            },
        )
    finally:
        producer.close()

    package = json.loads(
        Path(exported["filePath"]).read_text(encoding="utf-8")
    )
    checkpoints = package["content"]["checkpoints"]
    assert [checkpoint["kind"] for checkpoint in checkpoints] == [
        "milestone",
        "milestone",
        "session-summary",
    ]
    assert all(
        checkpoint["id"].startswith("milestone-")
        for checkpoint in checkpoints[:2]
    )
    assert exported["verification"]["counts"]["milestones"] == 2
    assert exported["verification"]["counts"]["findings"] == 2
    assert exported["findingEvidenceMap"] == [
        {
            "milestoneId": checkpoints[0]["id"],
            "milestoneTitle": "Evidence collection",
            "findingId": "finding-auth-failure",
            "statement": "The callback request was rejected.",
            "status": "confirmed",
            "confidence": "high",
            "evidenceIds": ["evidence-auth-har"],
        },
        {
            "milestoneId": checkpoints[1]["id"],
            "milestoneTitle": "Implementation validation",
            "findingId": "finding-fix-validated",
            "statement": "The corrected flow completed.",
            "status": "supported",
            "evidenceIds": ["evidence-query-result"],
        },
    ]

    receiver = McpProcess(
        tmp_path / "milestone-receiver",
        {"HANDOFF_TOOL_PROFILE": "cli"},
    )
    try:
        resumed = receiver.call_tool(
            "continue_from_handoff",
            {"filePath": exported["filePath"]},
        )
    finally:
        receiver.close()

    assert len(resumed["milestoneCheckpoints"]) == 2
    assert resumed["findingEvidenceMap"] == exported["findingEvidenceMap"]
    report = resumed["mandatoryUserReport"]
    assert "## Milestone checkpoints" in report
    assert "### Evidence collection" in report
    assert (
        "[confirmed] finding-auth-failure: "
        "The callback request was rejected. "
        "(evidence: evidence-auth-har)"
    ) in report


def test_rejects_invalid_milestone_evidence_links(tmp_path: Path) -> None:
    producer = McpProcess(
        tmp_path / "invalid-milestone-producer",
        {"HANDOFF_TOOL_PROFILE": "full"},
    )
    try:
        with pytest.raises(
            AssertionError,
            match="undeclared evidence ID",
        ):
            producer.call_tool(
                "create_handoff_package",
                {
                    "analysisRecord": {
                        "summary": "Invalid evidence association.",
                    },
                    "milestones": [
                        {
                            "title": "Invalid milestone",
                            "summary": "References missing evidence.",
                            "findings": [
                                {
                                    "id": "finding-missing-evidence",
                                    "statement": "Unsupported conclusion.",
                                    "status": "confirmed",
                                    "evidenceIds": ["missing-evidence"],
                                }
                            ],
                        }
                    ],
                },
            )
    finally:
        producer.close()


def test_creates_and_continues_portable_handoff_bundle(
    tmp_path: Path,
) -> None:
    session_history = tmp_path / "safe-session-events.json"
    session_history.write_text(
        json.dumps(
            {
                "schemaVersion": "1.0",
                "events": [
                    {
                        "type": "user.message",
                        "content": "Investigate the callback failure.",
                    },
                    {
                        "type": "assistant.message",
                        "content": "The callback was rejected.",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    session_share = tmp_path / "session-share.md"
    session_share.write_text(
        "# Shared session\n\nReviewed visible session history.",
        encoding="utf-8",
    )
    evidence_file = tmp_path / "authentication.har"
    evidence_file.write_text(
        '{"log":{"entries":[]}}',
        encoding="utf-8",
    )

    producer = McpProcess(
        tmp_path / "bundle-producer",
        {"HANDOFF_TOOL_PROFILE": "cli"},
    )
    try:
        bundled = producer.call_tool(
            "export_session_handoff",
            {
                "analysisRecord": {
                    "summary": "Investigated the authentication callback.",
                    "observations": ["Reviewed the safe session export."],
                    "decisions": ["Transfer a verified portable bundle."],
                    "nextSteps": ["Revalidate the HAR after import."],
                },
                "source": {
                    "nodeLabel": "Authentication callback investigation",
                },
                "milestones": [
                    {
                        "title": "Root cause investigation",
                        "summary": "Validated the callback rejection.",
                        "findings": [
                            {
                                "id": "finding-callback-rejected",
                                "statement": "The callback request was rejected.",
                                "status": "confirmed",
                                "evidenceIds": ["authentication-har"],
                            }
                        ],
                    }
                ],
                "sessionHistoryFile": {
                    "id": "safe-session-history",
                    "filePath": str(session_history),
                    "description": "Filtered high-fidelity session events",
                    "mediaType": "application/json",
                },
                "sessionShareFile": {
                    "id": "session-share",
                    "filePath": str(session_share),
                    "description": "Human-readable CLI session share",
                    "mediaType": "text/markdown",
                },
                "evidenceFiles": [
                    {
                        "id": "authentication-har",
                        "filePath": str(evidence_file),
                        "description": "Authentication network trace",
                        "mediaType": "application/json",
                    }
                ],
                "includeFileContents": True,
                "sensitivityReviewConfirmed": True,
                "destinationDirectory": str(tmp_path / "bundles"),
            },
        )
    finally:
        producer.close()

    bundle_path = Path(bundled["bundlePath"])
    assert bundle_path.is_file()
    assert bundled["packageContainsFileContents"] is True
    assert bundled["secureTransferRequired"] is True
    assert bundled["verification"]["valid"] is True
    assert [entry["role"] for entry in bundled["manifest"]["entries"]] == [
        "handoff-package",
        "session-history",
        "session-share",
        "evidence",
    ]

    with zipfile.ZipFile(bundle_path) as archive:
        names = set(archive.namelist())
        assert {
            "manifest.json",
            "handoff.agent-handoff.json",
            "checksums.sha256",
        }.issubset(names)
        package = json.loads(
            archive.read("handoff.agent-handoff.json").decode("utf-8")
        )
        artifact = next(
            item
            for item in package["content"]["artifacts"]
            if item["id"] == "authentication-har"
        )
        assert artifact["uri"].startswith("bundle://evidence/")
        assert "filePath" not in artifact

    receiver = McpProcess(
        tmp_path / "bundle-receiver",
        {"HANDOFF_TOOL_PROFILE": "cli"},
    )
    try:
        resumed = receiver.call_tool(
            "continue_from_handoff",
            {
                "filePath": str(bundle_path),
            },
        )
    finally:
        receiver.close()

    assert resumed["verification"]["valid"] is True
    assert resumed["bundlePath"] == str(bundle_path.resolve())
    assert resumed["sessionName"] == (
        "Authentication callback investigation (handoff)"
    )
    assert len(resumed["bundledFiles"]) == 3
    assert all(
        Path(item["extractedPath"]).is_file()
        for item in resumed["bundledFiles"]
    )
    extracted_evidence = next(
        item
        for item in resumed["bundledFiles"]
        if item["id"] == "authentication-har"
    )
    assert Path(extracted_evidence["extractedPath"]).read_text(
        encoding="utf-8"
    ) == evidence_file.read_text(encoding="utf-8")
    assert "## Bundled session and evidence files" in (
        resumed["mandatoryUserReport"]
    )
    assert resumed["findingEvidenceMap"][0]["evidenceIds"] == [
        "authentication-har"
    ]


def test_default_bundle_auto_exports_safe_session_and_artifact_files(
    tmp_path: Path,
) -> None:
    session_id = "session-auto-bundle"
    session_directory = tmp_path / "session-state" / session_id
    session_directory.mkdir(parents=True)
    events = [
        {
            "type": "session.start",
            "id": "event-start",
            "timestamp": "2026-09-02T01:00:00.000Z",
            "data": {
                "sessionId": session_id,
                "producer": "copilot-agent",
                "selectedModel": "gpt-test",
                "context": {"cwd": r"C:\case"},
            },
        },
        {
            "type": "system.message",
            "id": "event-system",
            "timestamp": "2026-09-02T01:00:01.000Z",
            "data": {"content": "private system instructions"},
        },
        {
            "type": "model.response",
            "id": "event-model",
            "timestamp": "2026-09-02T01:00:02.000Z",
            "data": {"reasoning": "private model data"},
        },
        {
            "type": "hook.start",
            "id": "event-hook",
            "timestamp": "2026-09-02T01:00:03.000Z",
            "data": {"command": "private hook"},
        },
        {
            "type": "user.message",
            "id": "event-user",
            "timestamp": "2026-09-02T01:00:04.000Z",
            "data": {
                "content": "Investigate the authentication failure.",
                "transformedContent": "must not be exported",
                "turnId": "turn-1",
            },
        },
        {
            "type": "assistant.message",
            "id": "event-assistant",
            "timestamp": "2026-09-02T01:00:05.000Z",
            "data": {
                "messageId": "message-1",
                "content": "The HAR confirms the failure.",
                "turnId": "turn-1",
                "reasoningOpaque": "must not be exported",
                "encryptedContent": "must not be exported",
            },
        },
        {
            "type": "tool.execution_complete",
            "id": "event-tool",
            "timestamp": "2026-09-02T01:00:06.000Z",
            "data": {
                "toolCallId": "tool-1",
                "success": True,
                "result": {
                    "status": "failed",
                    "token": "must be redacted",
                },
                "toolTelemetry": {"duration": 123},
            },
        },
    ]
    (session_directory / "events.jsonl").write_text(
        "\n".join(json.dumps(event) for event in events),
        encoding="utf-8",
    )
    evidence_file = tmp_path / "authentication.har"
    evidence_file.write_text(
        '{"log":{"entries":[{"response":{"status":401}}]}}',
        encoding="utf-8",
    )

    producer = McpProcess(
        tmp_path / "auto-bundle-producer",
        {
            "HANDOFF_TOOL_PROFILE": "cli",
            "HANDOFF_SESSION_STATE_DIR": str(tmp_path / "session-state"),
        },
    )
    try:
        bundled = producer.call_tool(
            "export_session_handoff",
            {
                "runId": session_id,
                "analysisRecord": {
                    "summary": "Investigated authentication failure.",
                    "observations": ["Reviewed the HAR."],
                    "nextSteps": ["Revalidate after import."],
                },
                "artifacts": [
                    {
                        "id": "authentication-har",
                        "path": str(evidence_file),
                        "description": "Original authentication HAR",
                        "mediaType": "application/json",
                    }
                ],
                "includeFileContents": True,
                "sensitivityReviewConfirmed": True,
                "destinationDirectory": str(tmp_path / "auto-bundles"),
            },
        )
    finally:
        producer.close()

    assert bundled["exportFormat"] == "bundle"
    assert bundled["safeSessionExport"]["retainedEventCount"] == 4
    assert bundled["safeSessionExport"]["excludedEventCount"] == 3
    assert bundled["safeSessionExport"]["excludedEventTypes"] == {
        "system.message": 1,
        "model.response": 1,
        "hook.start": 1,
    }
    assert [item["role"] for item in bundled["includedFiles"]] == [
        "session-history",
        "evidence",
    ]

    with zipfile.ZipFile(bundled["bundlePath"]) as archive:
        names = archive.namelist()
        session_name = next(
            name for name in names if name.startswith("session/")
        )
        evidence_name = next(
            name for name in names if name.startswith("evidence/")
        )
        safe_session = json.loads(archive.read(session_name))
        serialized = json.dumps(safe_session["events"])
        assert "private system instructions" not in serialized
        assert "private model data" not in serialized
        assert "private hook" not in serialized
        assert "reasoningOpaque" not in serialized
        assert "encryptedContent" not in serialized
        assert "toolTelemetry" not in serialized
        assert "transformedContent" not in serialized
        tool_event = next(
            event
            for event in safe_session["events"]
            if event["type"] == "tool.execution_complete"
        )
        assert "token" not in tool_event["data"]["result"]
        assert archive.read(evidence_name) == evidence_file.read_bytes()
        package = json.loads(
            archive.read("handoff.agent-handoff.json")
        )
        evidence_artifact = next(
            item
            for item in package["content"]["artifacts"]
            if item["id"] == "authentication-har"
        )
        assert evidence_artifact["uri"].startswith("bundle://evidence/")
        assert str(evidence_file) not in json.dumps(package)


def test_rejects_tampered_handoff_bundle(tmp_path: Path) -> None:
    evidence_file = tmp_path / "evidence.log"
    evidence_file.write_text("original evidence", encoding="utf-8")
    session_history = tmp_path / "safe-session.json"
    session_history.write_text(
        '{"schemaVersion":"1.0","events":[]}',
        encoding="utf-8",
    )
    producer = McpProcess(
        tmp_path / "tamper-producer",
        {"HANDOFF_TOOL_PROFILE": "cli"},
    )
    try:
        bundled = producer.call_tool(
            "export_session_handoff",
            {
                "analysisRecord": {"summary": "Bundle tamper test."},
                "sessionHistoryFile": {
                    "id": "safe-session-history",
                    "filePath": str(session_history),
                },
                "evidenceFiles": [
                    {
                        "id": "evidence-log",
                        "filePath": str(evidence_file),
                    }
                ],
                "includeFileContents": True,
                "sensitivityReviewConfirmed": True,
                "destinationDirectory": str(tmp_path / "tamper-bundles"),
            },
        )
    finally:
        producer.close()

    source_bundle = Path(bundled["bundlePath"])
    tampered_bundle = tmp_path / "tampered.handoff-bundle.zip"
    with zipfile.ZipFile(source_bundle) as source:
        entries = {
            name: source.read(name)
            for name in source.namelist()
        }
    evidence_name = next(
        name for name in entries if name.startswith("evidence/")
    )
    entries[evidence_name] = b"tampered evidence"
    with zipfile.ZipFile(tampered_bundle, "w") as target:
        for name, content in entries.items():
            target.writestr(name, content)

    receiver = McpProcess(
        tmp_path / "tamper-receiver",
        {"HANDOFF_TOOL_PROFILE": "cli"},
    )
    try:
        with pytest.raises(AssertionError, match="hash mismatch"):
            receiver.call_tool(
                "continue_from_handoff",
                {"filePath": str(tampered_bundle)},
            )
    finally:
        receiver.close()


def test_rejects_unsafe_handoff_bundle_path(tmp_path: Path) -> None:
    unsafe_bundle = tmp_path / "unsafe.handoff-bundle.zip"
    with zipfile.ZipFile(unsafe_bundle, "w") as archive:
        archive.writestr("../escape.txt", "unsafe")

    receiver = McpProcess(
        tmp_path / "unsafe-bundle-receiver",
        {"HANDOFF_TOOL_PROFILE": "cli"},
    )
    try:
        with pytest.raises(AssertionError, match="unsafe path"):
            receiver.call_tool(
                "continue_from_handoff",
                {"filePath": str(unsafe_bundle)},
            )
    finally:
        receiver.close()


def test_atomic_export_lists_original_evidence_without_exporting_it(
    mcp: McpProcess,
) -> None:
    handoff = create_handoff(
        mcp,
        artifacts=[
            {
                "path": r"C:\case\authentication.har",
                "description": "Original authentication evidence",
            }
        ],
    )
    handoff_id = handoff["package"]["handoffId"]

    exported = mcp.call_tool(
        "export_handoff",
        {"handoffId": handoff_id},
    )
    assert Path(exported["filePath"]).is_file()
    assert exported["originalEvidenceRequired"] == [
        {
            "location": r"C:\case\authentication.har",
            "description": "Original authentication evidence",
        }
    ]
    assert "Prepare the listed original evidence" in (
        exported["engineerActionRequired"]
    )


def test_rejects_tampering_after_package_creation(mcp: McpProcess) -> None:
    package = deepcopy(create_handoff(mcp)["package"])
    package["content"]["analysisRecord"]["summary"] = "Tampered"

    verification = mcp.call_tool("verify_handoff", {"package": package})

    assert verification["verification"]["valid"] is False
    assert verification["verification"]["integrityValid"] is False


def test_redacts_sensitive_keys_and_bearer_values(mcp: McpProcess) -> None:
    handoff = create_handoff(
        mcp,
        state_snapshot={
            "password": "secret",
            "message": "Authorization: ******",
        },
    )

    snapshot = handoff["package"]["content"]["stateSnapshot"]
    assert snapshot == {
        "password": "[REDACTED]",
        "message": "Authorization: ******",
    }


def create_handoff(
    mcp: McpProcess,
    *,
    state_snapshot: dict[str, Any] | None = None,
    allowed_actors: list[dict[str, str]] | None = None,
    observations: list[Any] | None = None,
    decisions: list[Any] | None = None,
    next_steps: list[Any] | None = None,
    artifacts: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    created = mcp.call_tool(
        "create_handoff",
        {
            "source": {
                "platform": "github-copilot-cli",
                "workflowId": "workflow-1",
                "workflowRevision": 1,
                "runId": "run-1",
                "nodeId": "node-1",
            },
            "content": {
                "analysisRecord": {
                    "summary": "Continue this task.",
                    "observations": observations or [],
                    "decisions": decisions or [],
                    "nextSteps": next_steps or [],
                },
                "stateSnapshot": state_snapshot or {},
                "artifacts": artifacts or [],
                "resumeInstructions": {
                    "objective": "Continue this task.",
                    "recommendedPrompt": "Verify evidence first.",
                },
            },
            "security": {
                "classification": "internal",
                "dataBoundary": "local-only",
                "allowedActors": allowed_actors or [],
            },
        },
    )
    handoff = created["handoff"]
    assert isinstance(handoff, dict)
    return handoff
