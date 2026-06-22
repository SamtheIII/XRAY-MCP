import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTestCaseTools } from './testCases';

export function registerAllTools(server: McpServer): void {
  registerTestCaseTools(server);
}
