import path from 'node:path';
import dotenv from 'dotenv';

// __dirname is dist/ — resolve credentials from the project root so the
// process can be launched from any working directory without an env block
// in claude_desktop_config.json.
const root = path.resolve(__dirname, '..');
dotenv.config({ path: [path.join(root, '.env.local'), path.join(root, '.env')], quiet: true });

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server';

async function main() {
  if (!process.env.XRAY_CLIENT_ID || !process.env.XRAY_CLIENT_SECRET) {
    process.stderr.write(
      'Error: XRAY_CLIENT_ID and XRAY_CLIENT_SECRET must be set in .env or .env.local\n',
    );
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${String(err)}\n`);
  process.exit(1);
});
