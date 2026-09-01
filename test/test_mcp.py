import json
from copy import deepcopy
from pathlib import Path
from typing import Any

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
            "create_handoff_package",
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
