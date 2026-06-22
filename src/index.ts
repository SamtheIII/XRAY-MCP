import dotenv from 'dotenv';
dotenv.config({ path: ['.env.local', '.env'] });
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server';

const parsedPort = Number(process.env.PORT ?? 3000);
const PORT = Number.isNaN(parsedPort) ? 3000 : parsedPort;

const parsedMax = Number(process.env.MAX_SESSIONS ?? 100);
const MAX_SESSIONS = Number.isNaN(parsedMax) || parsedMax <= 0 ? 100 : parsedMax;

const parsedIdle = Number(process.env.SESSION_IDLE_MS ?? 30 * 60 * 1000);
const SESSION_IDLE_MS = Number.isNaN(parsedIdle) || parsedIdle <= 0 ? 30 * 60 * 1000 : parsedIdle;

const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? `localhost:${PORT},127.0.0.1:${PORT}`)
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const app = express();

const parsedTrust = Number(process.env.TRUST_PROXY ?? 0);
app.set('trust proxy', Number.isNaN(parsedTrust) ? 0 : parsedTrust);

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use((req, res, next) => {
  const host = req.headers.host?.toLowerCase();
  if (!host || !ALLOWED_HOSTS.includes(host)) {
    res.status(403).json({ error: 'Forbidden: host not allowed' });
    return;
  }
  next();
});

app.use(express.json());

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down' },
});

interface Session {
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}
const transports = new Map<string, Session>();

const sweepTimer = setInterval(() => {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, session] of transports) {
    if (session.lastSeen < cutoff) {
      transports.delete(id);
      void session.transport.close();
    }
  }
}, Math.min(SESSION_IDLE_MS, 60 * 1000));
sweepTimer.unref(); // don't keep the process alive just for the sweep

app.all('/mcp', mcpLimiter, async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      const session = transports.get(sessionId)!;
      session.lastSeen = Date.now();
      await session.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === 'POST' && isInitializeRequest(req.body)) {
      if (transports.size >= MAX_SESSIONS) {
        res.status(503).json({ error: 'Server at capacity: too many active sessions' });
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };

      const server = createServer();
      await server.connect(transport);

      // Register before handleRequest — the initialize response goes to the client
      // inside handleRequest, so the session must be in the map before that happens
      // or a fast follow-up request won't find it.
      if (transport.sessionId) {
        transports.set(transport.sessionId, { transport, lastSeen: Date.now() });
      }

      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({ error: 'Bad request: send an initialize request to start a session' });
  } catch (err) {
    process.stderr.write(`MCP request error: ${String(err)}\n`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const e = err as { status?: number; statusCode?: number };
  const status = e?.status ?? e?.statusCode ?? 500;
  process.stderr.write(`Request error (${status}): ${String(err)}\n`);
  if (!res.headersSent) {
    if (status >= 400 && status < 500) {
      res.status(status).json({ error: err instanceof Error ? err.message : 'Bad request' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

const HOST = process.env.HOST ?? '127.0.0.1';
const httpServer = app.listen(PORT, HOST, () => {
  process.stderr.write(`Xray MCP Server running on http://${HOST}:${PORT}\n`);
});

function shutdown(signal: string): void {
  process.stderr.write(`Received ${signal}, shutting down\n`);
  clearInterval(sweepTimer);
  // Close transports inside the callback so in-flight responses finish before
  // their streams are torn down.
  httpServer.close(() => {
    for (const session of transports.values()) {
      void session.transport.close();
    }
    process.exit(0);
  });
  // Force-exit if connections refuse to drain within 10s.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
