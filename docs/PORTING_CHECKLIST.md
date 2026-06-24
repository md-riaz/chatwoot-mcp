# MCP Tool Porting Checklist

Node now exposes all 66 previous Python MCP tool names.

## Parity Status

- [x] 66/66 Python MCP tool names registered in Node.
- [x] TypeScript build passes.
- [x] Streamable HTTP + legacy SSE transport remain available.
- [x] Semantic/vector tools call the split embedding service instead of bundling embeddings into Node.

## Important Runtime Notes

- Semantic/vector tools require `EMBEDDING_SERVICE_URL`.
- All Chatwoot live/native tools require `CHATWOOT_BASE_URL` and `CHATWOOT_API_TOKEN`.
- Cached analytics tools require read access to the existing PostgreSQL/pgvector cache.
- Node tool outputs are parity-oriented, not byte-for-byte copies of old Python markdown.
- Keep current live Python MCP until shadow testing verifies real outputs against production data.
