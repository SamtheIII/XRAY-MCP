import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools } from './tools/index';

export function createServer(): McpServer {
  const server = new McpServer(
    { name: 'xray-mcp-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  registerAllTools(server);

  return server;
}
