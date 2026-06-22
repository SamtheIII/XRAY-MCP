# Xray MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that connects Claude and any MCP-compatible framework to the [Xray Cloud](https://www.getxray.app) test management API.

Manage your Xray test cases, executions, and traceability through natural language — no Xray UI required.

## Purpose

Built to connect with Claude Desktop and CLI-based workflows for streamlined development and automation.
If you find any issues, bugs, or opportunities for improvement, please open a Pull Request (PR) with your proposed changes.

---

## What It Does

Instead of manually navigating the Xray UI, you can say:

> "Create a test case for login with invalid credentials"

> "Mark SRV360-101 as PASSED in execution SRV360-200"

> "Give me a pass/fail summary for execution SRV360-200"

The server handles all Xray API calls on your behalf.

---

## Available Tools

| Tool | Description | Parameters |
|------|-------------|-----------|
| `get_test_case` | Fetch a test case and its steps | `issueId` |
| `create_test_case` | Create a new manual test case | `projectKey`, `summary`, `steps?` |
| `create_test_execution` | Create a test execution | `projectKey`, `summary`, `testCaseId` |
| `update_test_run_status` | Set PASSED / FAILED / BLOCKED on a run | `executionId`, `testCaseId`, `status` |
| `search_test_cases` | Find test cases by keyword, label, or status | `query`, `limit?` |
| `get_test_execution_report` | Pass/fail summary for an execution | `executionId` |
| `get_tests_for_requirement` | List test cases covering a Jira story | `requirementId` |

---

## Requirements

- [Node.js 18+](https://nodejs.org)
- Xray Cloud account with API credentials ([how to get them](https://docs.getxray.app/display/XRAYCLOUD/Global+Settings%3A+API+Keys))

---

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/your-org/xray-mcp-server.git
cd xray-mcp-server
```

**Windows (recommended)** — run the setup script. It installs dependencies, builds, saves credentials, and registers the MCP server in both Claude Desktop and Claude Code automatically:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

**Manual setup:**

```bash
# 2. Install dependencies
npm install

# 3. Add your credentials
cp .env.example .env.local
# Edit .env.local and fill in XRAY_CLIENT_ID and XRAY_CLIENT_SECRET

# 4. Build
npm run build
```

---

## Connecting to Claude Desktop

This is the primary use case. Claude Desktop spawns the server as a local stdio process — no port, no HTTP, no network exposure.

**Windows users: run `setup.ps1` — it finds the correct config file and registers the server automatically.**

For manual setup, add this to your Claude Desktop config file:

**Mac:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows (standard install):** `%APPDATA%\Roaming\Claude\claude_desktop_config.json`  
**Windows (Store install):** `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "xray": {
      "command": "node",
      "args": ["C:\\path\\to\\xray-mcp-server\\dist\\stdio.js"]
    }
  }
}
```

Update the path in `args` to match where you cloned the repo. Credentials are loaded automatically from `.env.local` in the project root — no need to put them in the config file.

Restart Claude Desktop after saving. The Xray tools will appear automatically.

---

## Connecting to Claude Code

Claude Code (the CLI) uses a separate MCP registry from Claude Desktop. `setup.ps1` registers the server automatically. For manual setup, run once from any terminal:

```bash
claude mcp add xray node "/path/to/xray-mcp-server/dist/stdio.js" --scope user
```

The `--scope user` flag makes it available in every Claude Code session, not just the current project. Start a new session after running this and the Xray tools will appear.

---

## Running the HTTP Server

For programmatic access from Python, Java, or any HTTP client, run the HTTP server instead:

```bash
npm start
# Server runs at http://localhost:3000/mcp
```

### Python

```python
import asyncio
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def call_xray_tool(tool_name, args):
    async with streamablehttp_client("http://localhost:3000/mcp") as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            return await session.call_tool(tool_name, args)

result = asyncio.run(call_xray_tool("create_test_case", {
    "projectKey": "TEST",
    "summary": "Verify login with invalid password",
    "steps": [
        { "action": "Enter invalid password", "result": "Error message shown" }
    ]
}))
```

### Java

```xml
<dependency>
    <groupId>io.modelcontextprotocol.sdk</groupId>
    <artifactId>mcp</artifactId>
    <version>0.9.0</version>
</dependency>
```

```java
var transport = new HttpClientSseClientTransport("http://localhost:3000/mcp");
var client = McpClient.sync(transport).build();
client.initialize();

var result = client.callTool(new CallToolRequest("get_test_case",
    Map.of("issueId", "TEST-101")
));
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XRAY_CLIENT_ID` | Yes | — | Xray Cloud API client ID |
| `XRAY_CLIENT_SECRET` | Yes | — | Xray Cloud API client secret |
| `PORT` | No | `3000` | HTTP server port (HTTP transport only) |
| `HOST` | No | `127.0.0.1` | Bind address. Set to `0.0.0.0` when running behind a reverse proxy. |
| `ALLOWED_HOSTS` | No | `localhost:<PORT>,127.0.0.1:<PORT>` | Comma-separated allowed `Host` headers. Set to your domain when deploying remotely. |
| `MAX_SESSIONS` | No | `100` | Max concurrent MCP sessions before new ones are rejected with `503`. |
| `SESSION_IDLE_MS` | No | `1800000` (30 min) | Idle time before a session is swept and closed. |
| `TRUST_PROXY` | No | `0` | Reverse-proxy hops to trust for real client IP. Set to `1` behind nginx/Caddy. |

Credentials are loaded from `.env.local` first, then `.env`.

---

## Project Structure

```
src/
├── index.ts          # HTTP server entry point (StreamableHTTP transport)
├── stdio.ts          # Claude Desktop entry point (stdio transport)
├── server.ts         # MCP server factory (shared by both entry points)
├── auth.ts           # Xray token caching (23hr TTL, in-flight dedup)
└── tools/
    ├── index.ts      # Tool registry
    └── testCases.ts  # All 7 tool implementations
```

---

## Development

```bash
# Run HTTP server in dev mode (no build step needed)
npm run dev

# Build TypeScript
npm run build

# Run tests
npm test
```

---

## HTTP Server — Public Deployment Notes

The HTTP server (`npm start`) is intended for local or internal network use. If you expose it publicly, be aware:

**1. No request authentication**
The `/mcp` endpoint has no API key or bearer token check. Add an auth middleware in `src/index.ts` before the MCP route.

**2. `ALLOWED_HOSTS` is not access control**
The Host header check closes DNS-rebinding. Any HTTP client can spoof a Host header, so it is not a substitute for real authentication.

**3. No HTTPS**
Run behind a TLS-terminating reverse proxy (nginx, Caddy). Set `TRUST_PROXY=1` so rate limiting reads the real client IP.

**4. In-memory session store**
Sessions live in process memory. A restart drops all active sessions. For multi-instance deployments you need an external session store (Redis, etc.).

---

## License

MIT
