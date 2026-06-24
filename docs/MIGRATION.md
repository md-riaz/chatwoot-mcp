# Migration Plan

Goal: split production into two deployable services without interrupting current live MCP.

## Target Services

### chatwoot-embedding-service

Python service:
- receives Chatwoot webhooks
- syncs resolved conversations
- embeds transcript chunks
- writes PostgreSQL + pgvector
- runs historical backfill

### chatwoot-mcp-node

Node/TypeScript service:
- exposes MCP tools
- reads PostgreSQL cache
- calls read-only Chatwoot APIs
- supports stdio, Streamable HTTP, and legacy SSE

## Safe Sequence

1. Keep current production server unchanged.
2. Run embedding service locally against a copied/staging DB.
3. Run Node MCP locally against read-only production DB credentials if needed.
4. Shadow test core reports against current Python MCP.
5. Port remaining MCP tools by category.
6. Deploy Node MCP to a shadow path such as `/node-mcp/mcp`.
7. Move one MCP client to shadow path.
8. Only after parity, decide whether to retire Python MCP route.
9. Move Chatwoot webhook only after embedding service is deployed and tested separately.

## Non-Goals For First Split

- No write/action Chatwoot tools.
- No webhook move during MCP migration.
- No production Nginx change until shadow service is ready.
- No shared mutable state between Node MCP replicas unless sticky sessions or external session storage is added.
