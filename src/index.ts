import 'dotenv/config';
import axios from 'axios';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const XRAY_BASE = 'https://xray.cloud.getxray.app/api/v2';

// --- Auth ---

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getToken(): Promise<string> {
  if (!process.env.XRAY_CLIENT_ID) throw new Error('XRAY_CLIENT_ID is required');
  if (!process.env.XRAY_CLIENT_SECRET) throw new Error('XRAY_CLIENT_SECRET is required');

  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const res = await axios.post<string>(`${XRAY_BASE}/authenticate`, {
    client_id: process.env.XRAY_CLIENT_ID,
    client_secret: process.env.XRAY_CLIENT_SECRET,
  });

  cachedToken = res.data;
  tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

// --- Tools ---

const TOOLS = [
  {
    name: 'get_test_case',
    description: 'Fetch a test case and its steps by Jira issue ID (e.g. TEST-101)',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Jira issue ID' },
      },
      required: ['issueId'],
    },
  },
  {
    name: 'create_test_case',
    description: 'Create a new manual test case with steps in Xray',
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'Jira project key (e.g. TEST)' },
        summary: { type: 'string', description: 'Test case title' },
        steps: {
          type: 'array',
          description: 'Test steps',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              data: { type: 'string' },
              result: { type: 'string' },
            },
            required: ['action', 'result'],
          },
        },
      },
      required: ['projectKey', 'summary'],
    },
  },
  {
    name: 'update_test_case',
    description: 'Replace the steps on an existing test case',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Jira issue ID of the test case' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              data: { type: 'string' },
              result: { type: 'string' },
            },
            required: ['action', 'result'],
          },
        },
      },
      required: ['issueId', 'steps'],
    },
  },
];

// --- Handlers ---

async function getTestCase(issueId: string) {
  const token = await getToken();
  const res = await axios.get(`${XRAY_BASE}/testcase/${issueId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { key, summary, status, testType, steps } = res.data;
  return { key, summary, status, type: testType?.name, steps };
}

async function createTestCase(args: {
  projectKey: string;
  summary: string;
  steps?: Array<{ action: string; data?: string; result: string }>;
}) {
  const token = await getToken();
  const res = await axios.post(
    `${XRAY_BASE}/testcase`,
    {
      fields: {
        summary: args.summary,
        project: { key: args.projectKey },
        issuetype: { name: 'Test' },
      },
      xray_test_type: 'Manual',
      steps: args.steps ?? [],
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { key, summary, status, testType, steps } = res.data;
  return { key, summary, status, type: testType?.name, steps };
}

async function updateTestCase(args: {
  issueId: string;
  steps: Array<{ action: string; data?: string; result: string }>;
}) {
  const token = await getToken();
  const res = await axios.put(
    `${XRAY_BASE}/testcase/${args.issueId}`,
    { steps: args.steps },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const { key, summary, status, testType, steps } = res.data;
  return { key, summary, status, type: testType?.name, steps };
}

// --- Server ---

const server = new Server(
  { name: 'xray-mcp-server', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    let result: unknown;
    if (name === 'get_test_case') result = await getTestCase(a.issueId as string);
    else if (name === 'create_test_case') result = await createTestCase(a as Parameters<typeof createTestCase>[0]);
    else if (name === 'update_test_case') result = await updateTestCase(a as Parameters<typeof updateTestCase>[0]);
    else return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };

    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Xray MCP Server running\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
