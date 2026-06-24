import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { createChatwootMcpServer } from "./tools.js";

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.mcpApiKey) {
    next();
    return;
  }
  if (req.header("authorization") === `Bearer ${config.mcpApiKey}`) {
    next();
    return;
  }
  res.status(401).json({ detail: "Unauthorized. Invalid Bearer Token." });
}

export async function runStdio(): Promise<void> {
  const server = createChatwootMcpServer();
  await server.connect(new StdioServerTransport());
}

export async function runHttpServer(): Promise<void> {
  const app = express();
  const base = config.basePath;
  const sseTransports = new Map<string, SSEServerTransport>();

  app.use(express.json({ limit: "4mb" }));
  app.get(`${base}/health`, (_req, res) => {
    res.json({ status: "healthy", server: "chatwoot-mcp-node", basePath: base || "/" });
  });

  app.all(`${base}/mcp`, requireAuth, async (req, res) => {
    const server = createChatwootMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });
    res.on("close", () => {
      void transport.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get(`${base}/sse`, requireAuth, async (req, res) => {
    const server = createChatwootMcpServer();
    const transport = new SSEServerTransport(`${base}/messages`, res);
    sseTransports.set(transport.sessionId, transport);
    res.on("close", () => {
      sseTransports.delete(transport.sessionId);
    });
    await server.connect(transport);
  });

  app.post(`${base}/messages`, requireAuth, async (req, res) => {
    const sessionId = String(req.query.sessionId ?? "");
    const transport = sseTransports.get(sessionId);
    if (!transport) {
      res.status(404).json({ detail: "Unknown SSE sessionId" });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.listen(config.port, () => {
    console.error(`chatwoot-mcp-node listening on :${config.port}${base || ""}`);
    console.error(`Streamable HTTP: ${base}/mcp`);
    console.error(`Legacy SSE: ${base}/sse`);
  });
}
