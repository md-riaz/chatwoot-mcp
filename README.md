# Chatwoot MCP

Local Node/TypeScript MCP split for read-only Chatwoot analytics.

This service is intended to replace the MCP surface of the current Python combined server after shadow testing. It does not process Chatwoot webhooks and does not generate embeddings.

## Current Scope

This repo has Node/TypeScript registrations for all 66 Python MCP tools from the previous combined server, plus Node-first read-only tools for clearer agent workflows.

For recent conversation audit requests like "last 7 days all conversations summary per inbox", agents should use `get_recent_resolved_conversation_summaries_by_inbox`. It returns cached resolved conversations grouped by account/inbox with each Chatwoot conversation ID and a compact transcript summary. If the user names an account, brand, inbox, product, or channel, call `list_available_chatwoot_scope` first and pass selected `account_id` and/or `inbox_ids`.

Semantic/vector tools remain embedding-free in this repo. They call the split Python embedding service through:

```env
EMBEDDING_SERVICE_URL=http://127.0.0.1:8000
EMBEDDING_API_KEY=YOUR_EMBEDDING_SERVICE_X_API_KEY
```

Tool parity notes are tracked in [docs/PORTING_CHECKLIST.md](docs/PORTING_CHECKLIST.md).

## Transports

Default mode is stdio:

```bash
npm run build
npm start
```

HTTP mode:

```bash
npm run build
npm run start:http
```

Legacy SSE compatibility mode uses the same HTTP server:

```bash
npm run start:sse
```

Routes are mounted under `BASE_PATH`:
- `GET ${BASE_PATH}/health`
- `POST/GET ${BASE_PATH}/mcp` for Streamable HTTP
- `GET ${BASE_PATH}/sse` for legacy SSE
- `POST ${BASE_PATH}/messages` for legacy SSE client messages

If `MCP_API_KEY` is set, `Authorization: Bearer <key>` is required.

## Local Setup

```bash
npm install
cp .env.example .env
npm run build
npm run start:http
```

Windows PowerShell:

```powershell
npm install
Copy-Item .env.example .env
npm run build
npm run start:http
```

## Shadow Testing

Run locally with a non-production port/path:

```env
PORT=3010
BASE_PATH=/node-mcp
```

Then compare selected tools against the live Python MCP before exposing this behind Nginx.

## Nginx Notes

Use path-preserving proxying. Do not depend on rewrite-only behavior because SSE advertises the POST message URL back to clients.

```nginx
location /node-mcp/ {
    proxy_pass http://127.0.0.1:3010/node-mcp/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

## Production Safety

Keep the live Python MCP endpoint unchanged until:
1. Every required tool has Node parity.
2. Date/timezone output matches expected semantics.
3. ChatGPT/Codex/Claude clients can connect to the shadow path.
4. A rollback path is documented.
