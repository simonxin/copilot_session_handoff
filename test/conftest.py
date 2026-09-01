import json
import os
import queue
import shutil
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "dist" / "server.js"
EXPECTED_TOOLS = {
    "accept_handoff",
    "create_handoff",
    "create_handoff_session",
    "export_handoff",
    "create_handoff_package",
    "get_handoff",
    "import_handoff",
    "import_handoff_file",
    "inspect_handoff",
    "list_handoffs",
    "revoke_handoff",
    "continue_from_handoff",
    "verify_handoff",
    "verify_handoff_file",
}


class McpProcess:
    def __init__(
        self,
        store: Path,
        environment_overrides: dict[str, str] | None = None,
    ) -> None:
        node = shutil.which("node")
        if node is None:
            raise RuntimeError("Node.js is required to run the Handoff MCP tests.")

        environment = os.environ.copy()
        environment.update(
            {
                "HANDOFF_STORE_DIR": str(store),
                "HANDOFF_ACTOR_ID": "person:receiver",
                "HANDOFF_ACTOR_KIND": "person",
            }
        )
        environment.update(environment_overrides or {})
        self._process = subprocess.Popen(
            [node, str(SERVER)],
            cwd=ROOT,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self._messages: queue.Queue[dict[str, Any]] = queue.Queue()
        self._reader = threading.Thread(target=self._read_messages, daemon=True)
        self._reader.start()
        self._next_id = 1
        self.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "handoff-python-tests", "version": "1.0.0"},
            },
        )
        self.notify("notifications/initialized")

    def _read_messages(self) -> None:
        assert self._process.stdout is not None
        for line in self._process.stdout:
            if line.strip():
                self._messages.put(json.loads(line))

    def request(
        self,
        method: str,
        params: dict[str, Any] | None = None,
        *,
        timeout: float = 10,
    ) -> dict[str, Any]:
        request_id = self._next_id
        self._next_id += 1
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            }
        )
        while True:
            try:
                message = self._messages.get(timeout=timeout)
            except queue.Empty as error:
                raise AssertionError(
                    f"Timed out waiting for MCP response to {method}.{self._diagnostics()}"
                ) from error
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise AssertionError(f"MCP request {method} failed: {message['error']}")
            result = message.get("result")
            assert isinstance(result, dict)
            return result

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        self._send(
            {
                "jsonrpc": "2.0",
                "method": method,
                "params": params or {},
            }
        )

    def list_tools(self) -> set[str]:
        result = self.request("tools/list")
        tools = result.get("tools")
        assert isinstance(tools, list)
        return {tool["name"] for tool in tools}

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        result = self.request(
            "tools/call",
            {"name": name, "arguments": arguments},
        )
        if result.get("isError"):
            raise AssertionError(f"MCP tool {name} failed: {result.get('content')}")
        structured = result.get("structuredContent")
        if isinstance(structured, dict):
            return structured
        content = result.get("content")
        assert isinstance(content, list) and content
        text = content[0].get("text")
        assert isinstance(text, str)
        parsed = json.loads(text)
        assert isinstance(parsed, dict)
        return parsed

    def close(self) -> None:
        if self._process.poll() is None:
            self._process.terminate()
            try:
                self._process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._process.kill()
                self._process.wait(timeout=5)

    def _send(self, message: dict[str, Any]) -> None:
        assert self._process.stdin is not None
        self._process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self._process.stdin.flush()

    def _diagnostics(self) -> str:
        return_code = self._process.poll()
        if return_code is None:
            return ""
        assert self._process.stderr is not None
        stderr = self._process.stderr.read().strip()
        return f" Server exited with code {return_code}: {stderr}"


@pytest.fixture
def mcp(tmp_path: Path) -> Iterator[McpProcess]:
    process = McpProcess(tmp_path / "store")
    try:
        yield process
    finally:
        process.close()
