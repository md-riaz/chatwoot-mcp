import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chatwootGet, extractAccounts, extractCollection } from "./chatwoot.js";
import { config, reportTimezoneOffset } from "./config.js";
import { reportTimestamp } from "./dates.js";
import { queryOne, queryRows } from "./db.js";

type ToolResult = { content: Array<{ type: "text"; text: string }> };
type Row = Record<string, unknown>;

const text = (markdown: string): ToolResult => ({ content: [{ type: "text", text: markdown }] });
const n = (value: unknown): number => (typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : Number(value ?? 0));
const pct = (part: number, total: number): string => (total ? `${((part / total) * 100).toFixed(1)}%` : "0.0%");
const clamp = (value: number | undefined, fallback: number, min = 1, max = 100): number =>
  Math.min(Math.max(Number(value ?? fallback), min), max);

function duration(seconds: unknown): string {
  const total = n(seconds);
  if (!Number.isFinite(total) || total <= 0) return "N/A";
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function compact(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fuzzyScore(candidate: string, query: string): number {
  const a = compact(candidate);
  const b = compact(query);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hit = words.filter((word) => candidate.toLowerCase().includes(word)).length;
  return hit / Math.max(words.length, 1);
}

function dateOnlyToUtc(value: string, endOfDay = false): string {
  const textValue = String(value).trim();
  if (/^\d+$/.test(textValue)) return new Date(Number(textValue) * 1000).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(textValue)) {
    const offset = config.reportTimezone === "Asia/Dhaka" ? "+06:00" : "+00:00";
    return new Date(`${textValue}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}${offset}`).toISOString();
  }
  const parsed = new Date(textValue);
  if (Number.isNaN(parsed.getTime())) throw new Error("date must be an ISO date/datetime or unix timestamp");
  return parsed.toISOString();
}

function dateFilter(
  column: string,
  opts: { days?: number; from_date?: string; to_date?: string },
  startIndex: number
): { sql: string; params: unknown[]; label: string } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.from_date) {
    params.push(dateOnlyToUtc(opts.from_date, false));
    clauses.push(`${column} >= $${startIndex + params.length - 1}`);
  }
  if (opts.to_date) {
    params.push(dateOnlyToUtc(opts.to_date, true));
    clauses.push(`${column} <= $${startIndex + params.length - 1}`);
  }
  if (clauses.length) {
    const parts = [opts.from_date ? `from ${opts.from_date}` : "", opts.to_date ? `to ${opts.to_date}` : ""].filter(Boolean);
    return { sql: `AND ${clauses.join(" AND ")}`, params, label: `${parts.join(" ")} (${config.reportTimezone})` };
  }
  if (opts.days && opts.days > 0) {
    params.push(opts.days);
    return { sql: `AND ${column} >= NOW() - ($${startIndex}::int * INTERVAL '1 day')`, params, label: `Last ${opts.days} Days` };
  }
  return { sql: "", params: [], label: "All Cached History" };
}

function likePattern(query: string): string {
  return `%${query.replace(/[%_]/g, "\\$&")}%`;
}

function snippet(content: string, patterns: string[]): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const found = lines.find((line) => patterns.some((pattern) => line.toLowerCase().includes(pattern.toLowerCase())));
  return (found ?? lines[0] ?? "Signal detected.").slice(0, 500);
}

async function embed(textValue: string): Promise<number[]> {
  if (!config.embeddingServiceUrl) {
    throw new Error("EMBEDDING_SERVICE_URL is not configured. Semantic/vector tools need the embedding service.");
  }
  const response = await fetch(`${config.embeddingServiceUrl.replace(/\/+$/, "")}/embed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.embeddingApiKey ? { "X-API-Key": config.embeddingApiKey } : {})
    },
    body: JSON.stringify({ texts: [textValue] })
  });
  if (!response.ok) throw new Error(`Embedding service ${response.status}: ${await response.text()}`);
  const data = (await response.json()) as { embeddings?: number[][] };
  const vector = data.embeddings?.[0];
  if (!vector) throw new Error("Embedding service returned no embedding");
  return vector;
}

function vectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

async function liveAccounts(): Promise<Array<{ id: number | string; name: string; role?: string }>> {
  try {
    return extractAccounts(await chatwootGet("/api/v1/profile"));
  } catch {
    const rows = await queryRows<{ account_id: string }>("SELECT DISTINCT account_id FROM conversations ORDER BY account_id");
    return rows.map((row) => ({ id: row.account_id, name: `Account ${row.account_id}` }));
  }
}

async function liveInboxes(accountId: number): Promise<Row[]> {
  return extractCollection(await chatwootGet(`/api/v1/accounts/${accountId}/inboxes`), ["payload", "inboxes"]);
}

async function nativeReportValue(accountId: number, inboxId: unknown, metric: string, since: string, until: string, timezoneOffset?: string): Promise<number> {
  const data = await chatwootGet<unknown>(`/api/v2/accounts/${accountId}/reports`, {
    type: "inbox",
    metric,
    since: reportTimestamp(since, false),
    until: reportTimestamp(until, true),
    id: String(inboxId),
    timezone_offset: timezoneOffset ?? reportTimezoneOffset()
  });
  const sum = (node: unknown): number => {
    if (Array.isArray(node)) return node.reduce((acc, item) => acc + sum(item), 0);
    if (node && typeof node === "object") {
      const record = node as Row;
      if (typeof record.value === "number") return record.value;
      return ["payload", "data", "results"].reduce((acc, key) => acc + sum(record[key]), 0);
    }
    return 0;
  };
  return sum(data);
}

async function transcript(conversationId: number, accountId: number): Promise<string> {
  const rows = await queryRows<{ content: string }>(
    "SELECT content FROM conversation_chunks WHERE account_id=$1 AND conversation_id=$2 ORDER BY chunk_index",
    [accountId, conversationId]
  );
  return rows.map((row) => row.content).join("\n");
}

function register(server: McpServer, name: string, description: string, inputSchema: Record<string, z.ZodTypeAny>, handler: (args: any) => Promise<ToolResult> | ToolResult): void {
  server.registerTool(name, { title: name, description, inputSchema }, handler);
}

export function registerParityTools(server: McpServer): void {
  register(server, "search_chatwoot_live", "Use only when the user needs live/current/open/unresolved Chatwoot data, exact terms not found in resolved cache, or items not yet synced. This is not semantic search.", {
    query: z.string(),
    account_id: z.number().int().default(1),
    search_type: z.enum(["conversations", "messages"]).default("conversations"),
    page: z.number().int().default(1)
  }, async ({ query, account_id, search_type, page }) => {
    const data = await chatwootGet(`/api/v1/accounts/${account_id}/search/${search_type}`, { q: query, page });
    return text(`### Chatwoot Live Search (${search_type}) Results for: "${query}"\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``);
  });

  register(server, "list_live_chatwoot_agents", "Use to list live Chatwoot account agents/users from the Chatwoot API. Read-only.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(100)
  }, async ({ account_id, limit }) => {
    const agents = extractCollection(await chatwootGet(`/api/v1/accounts/${account_id}/agents`), ["payload", "agents"]).slice(0, clamp(limit, 100, 1, 300));
    let out = `### Live Chatwoot Agents (Account ${account_id})\n\n`;
    for (const a of agents) out += `- **${a.name ?? "Unnamed"}** | id: \`${a.id ?? "N/A"}\` | role: ${a.role ?? "N/A"} | availability: ${a.availability_status ?? "N/A"}\n`;
    return text(out || "No live agents returned.");
  });

  register(server, "list_chatwoot_inboxes", "Use to identify live Chatwoot inbox IDs/names before resolved-cache inbox analysis or explicitly live inbox questions.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(100)
  }, async ({ account_id, limit }) => {
    const inboxes = (await liveInboxes(account_id)).slice(0, clamp(limit, 100, 1, 300));
    let out = `### Chatwoot Inboxes (Account ${account_id})\n\n| Inbox | ID | Channel |\n| - | -: | - |\n`;
    for (const i of inboxes) out += `| ${i.name ?? "Unnamed"} | ${i.id ?? "N/A"} | ${i.channel_type ?? (i.channel as Row | undefined)?.type ?? "N/A"} |\n`;
    return text(out);
  });

  register(server, "find_chatwoot_inboxes", "Searches live Chatwoot inbox names/IDs across accessible accounts. A brand can match Messenger, WhatsApp, and Livechat.", {
    query: z.string(),
    account_id: z.number().int().optional(),
    limit: z.number().int().default(50)
  }, async ({ query, account_id, limit }) => {
    const accounts = account_id ? [{ id: account_id, name: `Account ${account_id}` }] : await liveAccounts();
    const matches: Array<Row & { account_id: unknown; account_name: string; score: number }> = [];
    for (const account of accounts) {
      for (const inbox of await liveInboxes(Number(account.id))) {
        const haystack = `${inbox.id ?? ""} ${inbox.name ?? ""} ${inbox.channel_type ?? ""}`;
        const score = fuzzyScore(haystack, query);
        if (score >= 0.72 || compact(haystack).includes(compact(query))) matches.push({ ...inbox, account_id: account.id, account_name: account.name, score });
      }
    }
    matches.sort((a, b) => b.score - a.score);
    let out = `### Chatwoot Inbox Search: \`${query}\`\n\nUse matching \`account_id\` and \`inbox_id\` with resolved-cache tools.\n\n`;
    for (const m of matches.slice(0, clamp(limit, 50, 1, 200))) {
      out += `- **${m.name ?? "Unnamed"}** | inbox_id: \`${m.id ?? "N/A"}\` | account: **${m.account_name}** (\`account_id=${m.account_id}\`) | channel: ${m.channel_type ?? (m.channel as Row | undefined)?.type ?? "N/A"}\n`;
    }
    return text(matches.length ? out : out + "- No matching inbox names/IDs found.\n");
  });

  register(server, "list_chatwoot_teams", "Use to list live Chatwoot teams from the Chatwoot API. Read-only.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(100)
  }, async ({ account_id, limit }) => {
    const teams = extractCollection(await chatwootGet(`/api/v1/accounts/${account_id}/teams`), ["payload", "teams"]).slice(0, clamp(limit, 100, 1, 300));
    let out = `### Chatwoot Teams (Account ${account_id})\n\n`;
    for (const t of teams) out += `- **${t.name ?? "Unnamed"}** | id: \`${t.id ?? "N/A"}\` | auto assign: ${t.allow_auto_assign ?? "N/A"}\n`;
    return text(out || "No teams returned.");
  });

  register(server, "list_chatwoot_labels", "Use to list live Chatwoot labels from the Chatwoot API.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(200)
  }, async ({ account_id, limit }) => {
    const labels = extractCollection(await chatwootGet(`/api/v1/accounts/${account_id}/labels`), ["payload", "labels"]).slice(0, clamp(limit, 200, 1, 500));
    let out = `### Chatwoot Labels (Account ${account_id})\n\n`;
    for (const l of labels) out += `- \`${l.title ?? l.name ?? "Unnamed"}\` | id: \`${l.id ?? "N/A"}\` | color: ${l.color ?? "N/A"}\n`;
    return text(out || "No labels returned.");
  });

  register(server, "search_chatwoot_contacts_live", "Use for live Chatwoot contact lookup by customer name, email, phone, or identifier.", {
    query: z.string(),
    account_id: z.number().int().default(1),
    page: z.number().int().default(1),
    limit: z.number().int().default(20)
  }, async ({ query, account_id, page, limit }) => {
    const contacts = extractCollection(await chatwootGet(`/api/v1/accounts/${account_id}/contacts/search`, { q: query, page }), ["payload", "contacts"]).slice(0, clamp(limit, 20, 1, 100));
    let out = `### Live Chatwoot Contact Search: \`${query}\` (Account ${account_id})\n\n`;
    for (const c of contacts) out += `- **${c.name ?? "Unknown"}** | contact_id: \`${c.id ?? "N/A"}\` | email: ${c.email ?? "N/A"} | phone: ${c.phone_number ?? "N/A"} | identifier: ${c.identifier ?? "N/A"}\n`;
    return text(contacts.length ? out : out + "No contacts returned.");
  });

  register(server, "get_chatwoot_native_inbox_breakdown", "Native read-only inbox-wise breakdown. Native resolutions_count counts resolution events, not unique conversations.", {
    account_id: z.number().int().default(1),
    since: z.string(),
    until: z.string(),
    metric: z.string().default("resolutions_count"),
    inbox_query: z.string().optional(),
    limit: z.number().int().default(100),
    timezone_offset: z.string().optional()
  }, async ({ account_id, since, until, metric, inbox_query, limit, timezone_offset }) => {
    const inboxes = await liveInboxes(account_id);
    const rows: Array<{ inbox: Row; value: number }> = [];
    for (const inbox of inboxes) {
      if (inbox_query && !compact(`${inbox.id ?? ""} ${inbox.name ?? ""} ${inbox.channel_type ?? ""}`).includes(compact(inbox_query))) continue;
      rows.push({ inbox, value: await nativeReportValue(account_id, inbox.id, metric, since, until, timezone_offset) });
    }
    rows.sort((a, b) => b.value - a.value);
    const shown = rows.slice(0, clamp(limit, 100, 1, 200));
    const total = shown.reduce((acc, row) => acc + row.value, 0);
    let out = `### Chatwoot Native Inbox-wise Breakdown (Account ${account_id})\n\n- Metric: \`${metric}\` | Window: ${since} to ${until} (${config.reportTimezone})\n- Timezone offset: \`${timezone_offset ?? reportTimezoneOffset()}\`\n`;
    if (metric === "resolutions_count") out += "- Count basis: Chatwoot native resolution events; repeated resolves on one conversation may count more than once.\n";
    out += `- Total across returned inboxes: **${total}**\n\n| Inbox | ID | Channel | Count |\n| - | -: | - | -: |\n`;
    for (const row of shown) out += `| ${row.inbox.name ?? "Unnamed"} | ${row.inbox.id ?? "N/A"} | ${row.inbox.channel_type ?? "N/A"} | ${row.value} |\n`;
    return text(out);
  });

  register(server, "find_chatwoot_accounts", "Fuzzy-searches accessible account/workspace names and returns exact account_id values.", {
    query: z.string(),
    limit: z.number().int().default(20)
  }, async ({ query, limit }) => {
    const accounts = await liveAccounts();
    const cacheRows = await queryRows<{ account_id: string; conversations: string; latest_activity: Date | null }>("SELECT account_id, COUNT(*) AS conversations, MAX(last_activity_at) AS latest_activity FROM conversations GROUP BY account_id");
    const cache = new Map(cacheRows.map((row) => [String(row.account_id), row]));
    const matches = accounts.map((account) => ({ account, score: fuzzyScore(`${account.id} ${account.name} ${account.role ?? ""}`, query) })).filter((m) => m.score >= 0.65).sort((a, b) => b.score - a.score);
    let out = `### Chatwoot Account Search: \`${query}\`\n\n`;
    for (const match of matches.slice(0, clamp(limit, 20, 1, 100))) {
      const c = cache.get(String(match.account.id));
      out += `- **${match.account.name}** -> \`account_id=${match.account.id}\` | match: ${match.score.toFixed(2)}${c ? ` | cached conversations: ${c.conversations} | latest cached activity: ${c.latest_activity ?? "N/A"}` : ""}\n`;
    }
    return text(matches.length ? out : out + "- No exact/fuzzy account match found.\n");
  });

  register(server, "semantic_search_resolved_conversations", "Semantic search across cached resolved Chatwoot conversations. Requires EMBEDDING_SERVICE_URL.", {
    query: z.string(),
    account_id: z.number().int().default(1),
    top_k: z.number().int().default(10),
    days: z.number().int().optional(),
    from_date: z.string().optional(),
    to_date: z.string().optional()
  }, async ({ query, account_id, top_k, days, from_date, to_date }) => {
    const vector = await embed(query);
    const df = dateFilter("c.last_activity_at", { days, from_date, to_date }, 3);
    const rows = await queryRows<{ conversation_id: string; chunk_index: number; chunk_text: string; similarity: string; contact_name: string; inbox_name: string; channel_type: string; status: string; labels: string[] }>(
      `SELECT cc.conversation_id, cc.chunk_index, cc.content AS chunk_text,
              1 - (cc.embedding <=> $1::vector) AS similarity,
              c.contact_name, c.inbox_name, c.channel_type, c.status, c.labels
       FROM conversation_chunks cc
       JOIN conversations c ON c.id=cc.conversation_id AND c.account_id=cc.account_id
       WHERE cc.account_id=$2 ${df.sql}
       ORDER BY cc.embedding <=> $1::vector
       LIMIT $${3 + df.params.length}`,
      [vectorLiteral(vector), account_id, ...df.params, clamp(top_k, 10, 1, 50)]
    );
    let out = `### Semantic Search Results (${df.label})\n\n`;
    for (const r of rows) out += `- **Conv #${r.conversation_id}** | similarity: ${Number(r.similarity).toFixed(3)} | ${r.contact_name ?? "Unknown"} | ${r.inbox_name ?? "N/A"} / ${r.channel_type ?? "N/A"}\n  - ${String(r.chunk_text).slice(0, 500).replace(/\n/g, " ")}\n`;
    return text(rows.length ? out : "No semantic matches found.");
  });

  register(server, "get_resolved_conversation_context", "Full cached metadata plus transcript chunks for an exact resolved conversation ID.", {
    conversation_id: z.number().int(),
    account_id: z.number().int().default(1)
  }, async ({ conversation_id, account_id }) => {
    const row = await queryOne<Row>("SELECT * FROM conversations WHERE account_id=$1 AND id=$2", [account_id, conversation_id]);
    if (!row) return text(`No cached conversation found for #${conversation_id}.`);
    const chunks = await queryRows<{ chunk_index: number; content: string }>("SELECT chunk_index, content FROM conversation_chunks WHERE account_id=$1 AND conversation_id=$2 ORDER BY chunk_index", [account_id, conversation_id]);
    let out = `### Conversation #${conversation_id} Context\n\n`;
    for (const [key, value] of Object.entries(row)) out += `- **${key}:** ${Array.isArray(value) ? value.join(", ") : value ?? "N/A"}\n`;
    out += "\n#### Transcript Chunks\n";
    for (const c of chunks) out += `\n##### Chunk ${c.chunk_index}\n${c.content}\n`;
    return text(out);
  });

  register(server, "keyword_search_resolved_conversations", "Exact keyword or phrase search across cached resolved Chatwoot transcripts.", {
    query: z.string(),
    account_id: z.number().int().default(1),
    limit: z.number().int().default(10),
    days: z.number().int().optional()
  }, async ({ query, account_id, limit, days }) => {
    const df = dateFilter("c.last_activity_at", { days }, 3);
    const rows = await queryRows<{ id: string; contact_name: string; agent_name: string; labels: string[]; content: string }>(
      `SELECT DISTINCT c.id, c.contact_name, c.agent_name, c.labels, cc.content
       FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id
       WHERE c.account_id=$1 AND cc.content ILIKE $2 ${df.sql}
       ORDER BY c.id DESC LIMIT $${3 + df.params.length}`,
      [account_id, likePattern(query), ...df.params, clamp(limit, 10, 1, 100)]
    );
    let out = `### Keyword Search Results: "${query}" (${df.label})\n\n`;
    for (const r of rows) out += `- **Conv #${r.id}** (${r.contact_name ?? "Unknown"}) | Agent: ${r.agent_name ?? "Unassigned"} | Labels: ${(r.labels ?? []).join(", ") || "None"}\n  - ${snippet(r.content, [query])}\n`;
    return text(rows.length ? out : out + "No cached resolved conversations found.");
  });

  register(server, "search_resolved_transcript_snippets", "Precise cached transcript snippets for an exact keyword. Returns chunk-level matches.", {
    query: z.string(),
    account_id: z.number().int().default(1),
    limit: z.number().int().default(10)
  }, async ({ query, account_id, limit }) => {
    const rows = await queryRows<{ id: string; conversation_id: string; chunk_index: number; content: string }>(
      "SELECT id, conversation_id, chunk_index, content FROM conversation_chunks WHERE account_id=$1 AND content ILIKE $2 ORDER BY updated_at DESC LIMIT $3",
      [account_id, likePattern(query), clamp(limit, 10, 1, 100)]
    );
    let out = `### Transcript Snippets: "${query}"\n\n`;
    for (const r of rows) out += `- **Chunk #${r.id}** | Conv #${r.conversation_id} | chunk ${r.chunk_index}\n  - ${snippet(r.content, [query])}\n`;
    return text(rows.length ? out : out + "No snippets found.");
  });

  register(server, "find_similar_transcript_chunks", "Find semantically similar chunks after a cached transcript chunk ID is known.", {
    chunk_id: z.number().int(),
    account_id: z.number().int().default(1),
    limit: z.number().int().default(5)
  }, async ({ chunk_id, account_id, limit }) => {
    const source = await queryOne<{ embedding: string; content: string }>("SELECT embedding::text AS embedding, content FROM conversation_chunks WHERE account_id=$1 AND id=$2", [account_id, chunk_id]);
    if (!source?.embedding) return text(`No cached chunk found for chunk_id ${chunk_id}, or chunk has no embedding.`);
    const rows = await queryRows<{ id: string; conversation_id: string; similarity: string; content: string }>(
      "SELECT id, conversation_id, 1 - (embedding <=> $1::vector) AS similarity, content FROM conversation_chunks WHERE account_id=$2 AND id<>$3 ORDER BY embedding <=> $1::vector LIMIT $4",
      [source.embedding, account_id, chunk_id, clamp(limit, 5, 1, 50)]
    );
    let out = `### Similar Transcript Chunks for #${chunk_id}\n\n`;
    for (const r of rows) out += `- **Chunk #${r.id}** | Conv #${r.conversation_id} | similarity: ${Number(r.similarity).toFixed(3)}\n  - ${String(r.content).slice(0, 400).replace(/\n/g, " ")}\n`;
    return text(rows.length ? out : out + "No similar chunks found.");
  });

  register(server, "find_similar_resolved_conversations", "Find other cached conversations with similar meaning or issue pattern after a conversation ID is known.", {
    conversation_id: z.number().int(),
    account_id: z.number().int().default(1),
    limit: z.number().int().default(5)
  }, async ({ conversation_id, account_id, limit }) => {
    const source = await queryOne<{ embedding: string }>("SELECT embedding::text AS embedding FROM conversation_chunks WHERE account_id=$1 AND conversation_id=$2 ORDER BY chunk_index LIMIT 1", [account_id, conversation_id]);
    if (!source?.embedding) return text(`No embedded chunks found for conversation #${conversation_id}.`);
    const rows = await queryRows<{ conversation_id: string; similarity: string; content: string; contact_name: string }>(
      `SELECT cc.conversation_id, MAX(1 - (cc.embedding <=> $1::vector)) AS similarity, MIN(cc.content) AS content, MAX(c.contact_name) AS contact_name
       FROM conversation_chunks cc JOIN conversations c ON c.account_id=cc.account_id AND c.id=cc.conversation_id
       WHERE cc.account_id=$2 AND cc.conversation_id<>$3
       GROUP BY cc.conversation_id
       ORDER BY MAX(1 - (cc.embedding <=> $1::vector)) DESC LIMIT $4`,
      [source.embedding, account_id, conversation_id, clamp(limit, 5, 1, 50)]
    );
    let out = `### Similar Conversations to #${conversation_id}\n\n`;
    for (const r of rows) out += `- **Conv #${r.conversation_id}** | ${r.contact_name ?? "Unknown"} | similarity: ${Number(r.similarity).toFixed(3)}\n  - ${String(r.content).slice(0, 350).replace(/\n/g, " ")}\n`;
    return text(rows.length ? out : out + "No similar conversations found.");
  });

  register(server, "get_resolved_conversation_summary", "Quick brief of one exact Chatwoot conversation ID from resolved cache.", {
    conversation_id: z.number().int(),
    account_id: z.number().int().default(1)
  }, async ({ conversation_id, account_id }) => {
    const row = await queryOne<Row>("SELECT id, contact_name, agent_name, resolved_by, labels, status, inbox_name, channel_type, last_activity_at, resolved_at FROM conversations WHERE account_id=$1 AND id=$2", [account_id, conversation_id]);
    if (!row) return text(`No cached conversation found for #${conversation_id}.`);
    const body = await transcript(conversation_id, account_id);
    return text(`### Conversation #${conversation_id} Summary\n\n- Contact: **${row.contact_name ?? "Unknown"}**\n- Agent: ${row.agent_name ?? row.resolved_by ?? "Unassigned"}\n- Status: ${row.status ?? "N/A"}\n- Labels: ${(row.labels as string[] | undefined)?.join(", ") || "None"}\n- Inbox/channel: ${row.inbox_name ?? "N/A"} / ${row.channel_type ?? "N/A"}\n- Resolved at: ${row.resolved_at ?? "N/A"}\n\n#### First/Last Transcript\n${body.slice(0, 800)}\n\n...\n\n${body.slice(-800)}`);
  });

  register(server, "summarize_resolved_conversation_batch", "Compact status, label, and agent overview for multiple conversation IDs.", {
    conversation_ids: z.array(z.number().int()),
    account_id: z.number().int().default(1)
  }, async ({ conversation_ids, account_id }) => {
    const rows = await queryRows<Row>(
      "SELECT id, contact_name, agent_name, resolved_by, labels, status, resolved_at FROM conversations WHERE account_id=$1 AND id = ANY($2::bigint[]) ORDER BY resolved_at DESC NULLS LAST",
      [account_id, conversation_ids]
    );
    let out = `### Conversation Batch Summary (Account ${account_id})\n\n`;
    for (const r of rows) out += `- **#${r.id}** | ${r.contact_name ?? "Unknown"} | agent: ${r.agent_name ?? r.resolved_by ?? "Unassigned"} | status: ${r.status ?? "N/A"} | labels: ${((r.labels as string[]) ?? []).join(", ") || "None"}\n`;
    return text(rows.length ? out : "No matching cached conversations found.");
  });

  register(server, "get_transcript_chunk_context", "Get surrounding chunk context from same conversation for a cached transcript chunk ID.", {
    chunk_id: z.number().int(),
    account_id: z.number().int().default(1)
  }, async ({ chunk_id, account_id }) => {
    const source = await queryOne<{ conversation_id: string; chunk_index: number }>("SELECT conversation_id, chunk_index FROM conversation_chunks WHERE account_id=$1 AND id=$2", [account_id, chunk_id]);
    if (!source) return text(`No chunk found for #${chunk_id}.`);
    const rows = await queryRows<{ id: string; chunk_index: number; content: string }>(
      "SELECT id, chunk_index, content FROM conversation_chunks WHERE account_id=$1 AND conversation_id=$2 AND chunk_index BETWEEN $3 AND $4 ORDER BY chunk_index",
      [account_id, source.conversation_id, source.chunk_index - 1, source.chunk_index + 1]
    );
    let out = `### Transcript Chunk Context (#${chunk_id}, Conv #${source.conversation_id})\n\n`;
    for (const r of rows) out += `#### Chunk ${r.chunk_index} (id ${r.id})\n${r.content}\n\n`;
    return text(out);
  });

  register(server, "get_resolved_conversation_outcome", "For one resolved conversation ID: how it ended, solved, and who resolved it.", {
    conversation_id: z.number().int(),
    account_id: z.number().int().default(1)
  }, async ({ conversation_id, account_id }) => {
    const row = await queryOne<Row>("SELECT contact_name, agent_name, resolved_by, labels, resolved_at, status FROM conversations WHERE account_id=$1 AND id=$2", [account_id, conversation_id]);
    if (!row) return text(`No cached conversation found for #${conversation_id}.`);
    const body = await transcript(conversation_id, account_id);
    return text(`### Conversation #${conversation_id} Outcome\n\n- Status: ${row.status ?? "N/A"}\n- Resolved by: **${row.resolved_by ?? row.agent_name ?? "Unknown"}**\n- Resolved at: ${row.resolved_at ?? "N/A"}\n- Labels: ${((row.labels as string[]) ?? []).join(", ") || "None"}\n\n#### Ending Evidence\n${snippet(body, ["resolved", "thank", "done", "fixed", "invoice", "payment"])}`);
  });

  register(server, "get_top_resolved_issue_labels", "Rank labels/categories by count across cached resolved conversations.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional(),
    limit: z.number().int().default(10)
  }, async ({ account_id, days, limit }) => {
    const df = dateFilter("last_activity_at", { days }, 2);
    const rows = await queryRows<{ label: string; count: string }>(
      `SELECT label, COUNT(*) FROM (SELECT unnest(labels) AS label FROM conversations WHERE account_id=$1 ${df.sql}) sub GROUP BY label ORDER BY COUNT(*) DESC LIMIT $${2 + df.params.length}`,
      [account_id, ...df.params, clamp(limit, 10, 1, 100)]
    );
    let out = `### Top Resolved Issue Labels (${df.label})\n\n`;
    for (const r of rows) out += `- **${r.label}**: ${r.count}\n`;
    return text(out);
  });

  register(server, "get_resolved_issue_label_trends", "Weekly label/category trend counts from cached resolved conversations.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional(),
    limit: z.number().int().default(10)
  }, async ({ account_id, days, limit }) => {
    const df = dateFilter("last_activity_at", { days }, 2);
    const rows = await queryRows<{ label: string; week: Date; count: string }>(
      `SELECT label, date_trunc('week', activity_at) AS week, COUNT(*) FROM (SELECT unnest(labels) AS label, last_activity_at AS activity_at FROM conversations WHERE account_id=$1 ${df.sql}) sub GROUP BY label, week ORDER BY week DESC, COUNT(*) DESC LIMIT $${2 + df.params.length}`,
      [account_id, ...df.params, clamp(limit, 10, 1, 100)]
    );
    let out = `### Support Issue Trends (Weekly - ${df.label})\n\n`;
    for (const r of rows) out += `- Week of **${String(r.week).slice(0, 10)}** | **${r.label}**: ${r.count}\n`;
    return text(out);
  });

  register(server, "compare_resolved_issue_periods", "Compare cached resolved conversation volume between two explicit date ranges using resolved_at.", {
    period1_start: z.string(),
    period1_end: z.string(),
    period2_start: z.string(),
    period2_end: z.string(),
    account_id: z.number().int().default(1)
  }, async ({ period1_start, period1_end, period2_start, period2_end, account_id }) => {
    const p1 = await queryOne<{ count: string }>("SELECT COUNT(*) FROM conversations WHERE account_id=$1 AND status='resolved' AND resolved_at BETWEEN $2 AND $3", [account_id, dateOnlyToUtc(period1_start), dateOnlyToUtc(period1_end, true)]);
    const p2 = await queryOne<{ count: string }>("SELECT COUNT(*) FROM conversations WHERE account_id=$1 AND status='resolved' AND resolved_at BETWEEN $2 AND $3", [account_id, dateOnlyToUtc(period2_start), dateOnlyToUtc(period2_end, true)]);
    const c1 = n(p1?.count), c2 = n(p2?.count), diff = c2 - c1;
    return text(`### Support Volume Comparison Report\n\n- **Period 1 (${period1_start} to ${period1_end}):** ${c1} conversations\n- **Period 2 (${period2_start} to ${period2_end}):** ${c2} conversations\n- **Change:** ${diff >= 0 ? "+" : ""}${diff} (${c1 ? ((diff / c1) * 100).toFixed(2) : "0.00"}%)\n`);
  });

  register(server, "get_resolved_conversation_volume_by_channel", "Group cached resolved conversation counts by channel type.", {
    account_id: z.number().int().default(1)
  }, async ({ account_id }) => {
    const rows = await queryRows<{ channel_type: string; count: string }>("SELECT channel_type, COUNT(*) FROM conversations WHERE account_id=$1 GROUP BY channel_type ORDER BY COUNT(*) DESC", [account_id]);
    let out = "### Issue Breakdown by Channel\n\n";
    for (const r of rows) out += `- **${r.channel_type ?? "Unknown Channel"}**: ${r.count} conversations\n`;
    return text(out);
  });

  register(server, "get_resolved_conversation_volume_by_inbox_brand", "Brand/product/service chat count across matching inboxes/channels. All means all matching resolved inboxes/conversations.", {
    query: z.string(),
    account_id: z.number().int().optional(),
    days: z.number().int().optional(),
    from_date: z.string().optional(),
    to_date: z.string().optional(),
    limit: z.number().int().default(50)
  }, async ({ query, account_id, days, from_date, to_date, limit }) => {
    const accounts = account_id ? [{ id: account_id, name: `Account ${account_id}` }] : await liveAccounts();
    const matches: Array<{ acc: number; accountName: string; inbox: Row }> = [];
    for (const account of accounts) {
      for (const inbox of await liveInboxes(Number(account.id))) {
        if (fuzzyScore(`${inbox.id} ${inbox.name} ${inbox.channel_type}`, query) >= 0.7) matches.push({ acc: Number(account.id), accountName: account.name, inbox });
      }
    }
    const df = dateFilter("resolved_at", { days, from_date, to_date }, 4);
    let total = 0;
    let out = `### Resolved Conversation Volume for Brand/Inboxes: \`${query}\` (${df.label})\n\n`;
    for (const m of matches.slice(0, clamp(limit, 50, 1, 200))) {
      const row = await queryOne<{ count: string }>(`SELECT COUNT(*) FROM conversations WHERE account_id=$1 AND status='resolved' AND inbox_id=$2 ${df.sql}`, [m.acc, m.inbox.id, ...df.params]);
      const count = n(row?.count);
      total += count;
      out += `- **${m.inbox.name ?? "Unnamed"}** | inbox_id: \`${m.inbox.id}\` | account: **${m.accountName}** (\`account_id=${m.acc}\`) | resolved conversations: **${count}**\n`;
    }
    out = out.replace("\n\n", `\n\n- **Total resolved conversations:** ${total}\n- **Matching inboxes counted:** ${matches.length}\n\n`);
    return text(matches.length ? out : `### Resolved Conversation Volume for Brand/Inboxes: \`${query}\`\n\n- No matching inbox names/IDs found.\n`);
  });

  register(server, "get_cached_conversation_volume_by_status", "Group cached database conversations by stored Chatwoot status.", {
    account_id: z.number().int().default(1)
  }, async ({ account_id }) => {
    const rows = await queryRows<{ status: string; count: string }>("SELECT status, COUNT(*) FROM conversations WHERE account_id=$1 GROUP BY status ORDER BY COUNT(*) DESC", [account_id]);
    return text("### Conversation Volume by Status\n\n" + rows.map((r) => `- **${r.status ?? "Unknown Status"}**: ${r.count} conversations`).join("\n"));
  });

  register(server, "get_emerging_resolved_issue_labels", "Identify labels/categories spiking in last 7 days compared with previous 23 days.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(5)
  }, async ({ account_id, limit }) => {
    const rows = await queryRows<{ label: string; recent: string; baseline: string }>(
      `SELECT label,
              COUNT(*) FILTER (WHERE activity_at >= NOW() - INTERVAL '7 days') AS recent,
              COUNT(*) FILTER (WHERE activity_at BETWEEN NOW() - INTERVAL '30 days' AND NOW() - INTERVAL '7 days') AS baseline
       FROM (SELECT unnest(labels) AS label, last_activity_at AS activity_at FROM conversations WHERE account_id=$1 AND last_activity_at IS NOT NULL) sub
       GROUP BY label ORDER BY recent DESC, baseline ASC LIMIT $2`,
      [account_id, clamp(limit, 5, 1, 50)]
    );
    let out = "### Emerging Issues (Spiking Recent Volume)\n\n";
    for (const r of rows) out += `- **${r.label}**: ${r.recent} in last 7 days (vs ${r.baseline} baseline)\n`;
    return text(out);
  });

  const signalTool = (name: string, title: string, patterns: string[]) => {
    register(server, name, title, {
      account_id: z.number().int().default(1),
      limit: z.number().int().default(10),
      days: z.number().int().optional()
    }, async ({ account_id, limit, days }) => {
      const df = dateFilter("c.last_activity_at", { days }, 2);
      const ors = patterns.map((_, i) => `cc.content ILIKE $${2 + df.params.length + i}`).join(" OR ");
      const rows = await queryRows<{ id: string; contact_name: string; agent_name: string; status: string; content: string }>(
        `SELECT DISTINCT c.id, c.contact_name, c.agent_name, c.status, cc.content
         FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id
         WHERE c.account_id=$1 ${df.sql} AND (${ors}) ORDER BY c.id DESC LIMIT $${2 + df.params.length + patterns.length}`,
        [account_id, ...df.params, ...patterns.map(likePattern), clamp(limit, 10, 1, 100)]
      );
      let out = `### ${title} (${df.label})\n\n`;
      for (const r of rows) out += `- **Conv #${r.id}** (${r.contact_name ?? "Unknown"}) | Agent: ${r.agent_name ?? "Unassigned"} | Status: ${r.status ?? "N/A"}\n  - ${snippet(r.content, patterns)}\n`;
      return text(rows.length ? out : out + "No matching signals found.");
    });
  };

  signalTool("get_negative_friction_conversations", "Negative/Friction Conversations", ["bad", "angry", "frustrated", "slow", "delay", "not working", "problem", "issue"]);
  signalTool("get_frustration_signal_conversations", "Frustration / Waiting Signals", ["frustrated", "waiting", "delay", "no response", "slow", "still"]);
  signalTool("get_churn_risk_signal_conversations", "Churn Risk Signals", ["cancel", "refund", "close account", "closing", "terminate", "churn"]);
  signalTool("get_escalation_signal_conversations", "Escalation Signals", ["manager", "supervisor", "escalate", "complaint", "formal complaint"]);

  register(server, "get_resolved_sentiment_signal_report", "High-level cached resolved-conversation sentiment signal report based on transcript keywords.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional()
  }, async ({ account_id, days }) => {
    const df = dateFilter("c.last_activity_at", { days }, 2);
    const row = await queryOne<{ total: string; negative: string; positive: string }>(
      `SELECT COUNT(DISTINCT c.id) AS total,
              COUNT(DISTINCT c.id) FILTER (WHERE cc.content ILIKE '%angry%' OR cc.content ILIKE '%frustrated%' OR cc.content ILIKE '%bad%' OR cc.content ILIKE '%not working%') AS negative,
              COUNT(DISTINCT c.id) FILTER (WHERE cc.content ILIKE '%thank%' OR cc.content ILIKE '%thanks%' OR cc.content ILIKE '%solved%' OR cc.content ILIKE '%great%') AS positive
       FROM conversations c LEFT JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id
       WHERE c.account_id=$1 ${df.sql}`,
      [account_id, ...df.params]
    );
    const total = n(row?.total), neg = n(row?.negative), pos = n(row?.positive);
    return text(`### Resolved Sentiment Signal Report (${df.label})\n\n- Total conversations scanned: ${total}\n- Positive signal conversations: ${pos} (${pct(pos, total)})\n- Negative/friction signal conversations: ${neg} (${pct(neg, total)})\n- Neutral/no obvious signal: ${Math.max(total - pos - neg, 0)}\n\nHeuristic keyword signal only, not CSAT/NPS.`);
  });

  register(server, "get_customer_resolved_history", "Find cached resolved support history by contact name.", {
    contact_name: z.string(),
    account_id: z.number().int().default(1)
  }, async ({ contact_name, account_id }) => customerHistory({ account_id, contact_name, limit: 25 }));

  register(server, "get_customer_resolved_history_by_identity", "Find cached resolved customer history by contact_id, contact_email, or contact_name.", {
    account_id: z.number().int().default(1),
    contact_id: z.number().int().optional(),
    contact_email: z.string().optional(),
    contact_name: z.string().optional(),
    limit: z.number().int().default(25)
  }, customerHistory);

  async function customerHistory({ account_id, contact_id, contact_email, contact_name, limit }: { account_id: number; contact_id?: number; contact_email?: string; contact_name?: string; limit?: number }): Promise<ToolResult> {
    const filters = ["account_id=$1"];
    const params: unknown[] = [account_id];
    if (contact_id) { params.push(contact_id); filters.push(`contact_id=$${params.length}`); }
    else if (contact_email) { params.push(contact_email); filters.push(`contact_email ILIKE $${params.length}`); }
    else if (contact_name) { params.push(likePattern(contact_name)); filters.push(`contact_name ILIKE $${params.length}`); }
    else return text("Provide contact_id, contact_email, or contact_name.");
    params.push(clamp(limit, 25, 1, 100));
    const rows = await queryRows<Row>(`SELECT id, contact_name, contact_email, agent_name, labels, status, resolved_at FROM conversations WHERE ${filters.join(" AND ")} ORDER BY resolved_at DESC NULLS LAST LIMIT $${params.length}`, params);
    let out = "### Customer Resolved History\n\n";
    for (const r of rows) out += `- **#${r.id}** | ${r.contact_name ?? "Unknown"} | ${r.contact_email ?? "N/A"} | agent: ${r.agent_name ?? "Unassigned"} | status: ${r.status ?? "N/A"} | labels: ${((r.labels as string[]) ?? []).join(", ") || "None"}\n`;
    return text(rows.length ? out : "No cached customer history found.");
  }

  register(server, "get_customer_unresolved_issue_signals", "Customer-specific resolved conversations where transcript suggests issue remained open when marked resolved.", {
    contact_name: z.string(),
    account_id: z.number().int().default(1),
    limit: z.number().int().default(10),
    days: z.number().int().optional()
  }, async ({ contact_name, account_id, limit, days }) => {
    const df = dateFilter("c.last_activity_at", { days }, 3);
    const patterns = ["not solved", "not fixed", "still", "waiting", "no response", "refund", "cancel"];
    const rows = await queryRows<{ id: string; agent_name: string; content: string }>(
      `SELECT DISTINCT c.id, c.agent_name, cc.content FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id WHERE c.account_id=$1 AND c.contact_name ILIKE $2 ${df.sql} AND (${patterns.map((_, i) => `cc.content ILIKE $${3 + df.params.length + i}`).join(" OR ")}) ORDER BY c.id DESC LIMIT $${3 + df.params.length + patterns.length}`,
      [account_id, likePattern(contact_name), ...df.params, ...patterns.map(likePattern), clamp(limit, 10, 1, 100)]
    );
    let out = `### Customer Unresolved-Issue Signals: ${contact_name}\n\n`;
    for (const r of rows) out += `- **Conv #${r.id}** | Agent: ${r.agent_name ?? "Unassigned"}\n  - ${snippet(r.content, patterns)}\n`;
    return text(rows.length ? out : out + "No unresolved issue signals found.");
  });

  register(server, "get_repeat_customer_contacts", "Find customers/contact names with multiple cached resolved conversations.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional(),
    limit: z.number().int().default(10)
  }, async ({ account_id, days, limit }) => {
    const df = dateFilter("last_activity_at", { days }, 2);
    const rows = await queryRows<{ contact_name: string; count: string; latest: Date }>(
      `SELECT contact_name, COUNT(*) AS count, MAX(last_activity_at) AS latest FROM conversations WHERE account_id=$1 AND contact_name IS NOT NULL ${df.sql} GROUP BY contact_name HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT $${2 + df.params.length}`,
      [account_id, ...df.params, clamp(limit, 10, 1, 100)]
    );
    return text("### Repeat Customer Contacts\n\n" + rows.map((r) => `- **${r.contact_name}**: ${r.count} conversations | latest: ${r.latest}`).join("\n"));
  });

  register(server, "get_vip_priority_conversations", "List cached resolved conversations tagged VIP/priority or with VIP-like contact names.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(10)
  }, async ({ account_id, limit }) => {
    const rows = await queryRows<Row>(
      "SELECT id, contact_name, agent_name, labels, resolved_at FROM conversations WHERE account_id=$1 AND (contact_name ILIKE '%vip%' OR contact_name ILIKE '%priority%' OR 'vip' = ANY(labels) OR 'priority' = ANY(labels)) ORDER BY resolved_at DESC NULLS LAST LIMIT $2",
      [account_id, clamp(limit, 10, 1, 100)]
    );
    return text("### VIP / Priority Conversations\n\n" + rows.map((r) => `- **#${r.id}** | ${r.contact_name ?? "Unknown"} | agent: ${r.agent_name ?? "Unassigned"} | labels: ${((r.labels as string[]) ?? []).join(", ")}`).join("\n"));
  });

  register(server, "find_customers_by_exact_issue_keyword", "Find customers whose cached resolved transcripts mention a specific exact issue keyword.", {
    issue_keyword: z.string(),
    account_id: z.number().int().default(1)
  }, async ({ issue_keyword, account_id }) => {
    const rows = await queryRows<Row>(
      "SELECT DISTINCT c.contact_name, c.contact_email, c.id FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id WHERE c.account_id=$1 AND cc.content ILIKE $2 ORDER BY c.id DESC LIMIT 50",
      [account_id, likePattern(issue_keyword)]
    );
    return text(`### Customers Mentioning "${issue_keyword}"\n\n` + rows.map((r) => `- **${r.contact_name ?? "Unknown"}** | ${r.contact_email ?? "N/A"} | Conv #${r.id}`).join("\n"));
  });

  registerAgentTools(server);
  registerProductReportTools(server);
}

function registerAgentTools(server: McpServer): void {
  register(server, "get_agent_resolution_workload", "Compare resolved-conversation workload counts by support agent from cached Chatwoot data.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional()
  }, async ({ account_id, days }) => {
    const df = dateFilter("last_activity_at", { days }, 2);
    const rows = await queryRows<{ agent: string; count: string }>(
      `SELECT COALESCE(agent_name, resolved_by, 'Unassigned') AS agent, COUNT(*) FROM conversations WHERE account_id=$1 ${df.sql} GROUP BY agent ORDER BY COUNT(*) DESC`,
      [account_id, ...df.params]
    );
    return text(`### Agent Resolution Workload (${df.label})\n\n` + rows.map((r) => `- **${r.agent}**: ${r.count}`).join("\n"));
  });

  register(server, "get_agent_label_mix", "Show which Chatwoot labels/categories each agent handled.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional()
  }, async ({ account_id, days }) => {
    const df = dateFilter("last_activity_at", { days }, 2);
    const rows = await queryRows<{ agent: string; label: string; count: string }>(
      `SELECT COALESCE(agent_name, resolved_by, 'Unassigned') AS agent, label, COUNT(*) FROM (SELECT agent_name, resolved_by, unnest(labels) AS label, last_activity_at FROM conversations WHERE account_id=$1 ${df.sql}) sub GROUP BY agent, label ORDER BY agent, COUNT(*) DESC`,
      [account_id, ...df.params]
    );
    let out = `### Agent Label Mix (${df.label})\n\n`;
    for (const r of rows) out += `- **${r.agent}** | ${r.label}: ${r.count}\n`;
    return text(out);
  });

  register(server, "get_agent_resolution_channel_mix", "Show which channels each agent resolves most often.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional()
  }, async ({ account_id, days }) => {
    const df = dateFilter("last_activity_at", { days }, 2);
    const rows = await queryRows<{ agent: string; channel_type: string; count: string }>(
      `SELECT COALESCE(agent_name, resolved_by, 'Unassigned') AS agent, COALESCE(channel_type, 'Unknown') AS channel_type, COUNT(*) FROM conversations WHERE account_id=$1 ${df.sql} GROUP BY agent, channel_type ORDER BY agent, COUNT(*) DESC`,
      [account_id, ...df.params]
    );
    let out = `### Agent Channel Mix (${df.label})\n\n`;
    for (const r of rows) out += `- **${r.agent}** | ${r.channel_type}: ${r.count}\n`;
    return text(out);
  });

  register(server, "list_chatwoot_agents", "Lists support agents found in cached resolved conversations, with optional fuzzy name search.", {
    account_id: z.number().int().default(1),
    query: z.string().optional(),
    days: z.number().int().optional(),
    limit: z.number().int().default(50)
  }, async ({ account_id, query, days, limit }) => {
    const df = dateFilter("last_activity_at", { days }, 2);
    const rows = await queryRows<{ name: string; count: string; latest: Date }>(
      `SELECT btrim(name) AS name, COUNT(*) AS count, MAX(last_activity_at) AS latest
       FROM (SELECT agent_name AS name, last_activity_at FROM conversations WHERE account_id=$1 ${df.sql} UNION ALL SELECT resolved_by AS name, last_activity_at FROM conversations WHERE account_id=$1 ${df.sql}) s
       WHERE name IS NOT NULL AND btrim(name) <> ''
       GROUP BY btrim(name) ORDER BY COUNT(*) DESC LIMIT $${2 + df.params.length * 2}`,
      [account_id, ...df.params, ...df.params, clamp(limit, 50, 1, 200)]
    );
    const filtered = query ? rows.map((r) => ({ ...r, score: fuzzyScore(r.name, query) })).filter((r) => r.score >= 0.55).sort((a, b) => b.score - a.score) : rows;
    return text(`### Cached Chatwoot Agents (${df.label})\n\n` + filtered.map((r: any) => `- **${r.name}**: ${r.count} handled | latest: ${r.latest}${r.score ? ` | match: ${r.score.toFixed(2)}` : ""}`).join("\n"));
  });

  register(server, "get_agent_sla_metrics", "Compare per-agent first-response and resolution timing from cached timestamps.", {
    account_id: z.number().int().default(1),
    agent_name: z.string().optional(),
    days: z.number().int().optional(),
    limit: z.number().int().default(20)
  }, async ({ account_id, agent_name, days, limit }) => {
    const df = dateFilter("last_activity_at", { days }, 2);
    const params: unknown[] = [account_id, ...df.params];
    const agentWhere = agent_name ? `AND (agent_name ILIKE $${params.push(likePattern(agent_name))} OR resolved_by ILIKE $${params.length})` : "";
    const rows = await queryRows<{ agent: string; total: string; first_covered: string; resolved_covered: string; avg_first: string; avg_resolution: string }>(
      `SELECT COALESCE(agent_name, resolved_by, 'Unassigned') AS agent, COUNT(*) AS total,
              COUNT(first_response_at) AS first_covered, COUNT(resolved_at) AS resolved_covered,
              AVG(EXTRACT(EPOCH FROM (first_response_at - COALESCE(chatwoot_created_at, created_at)))) AS avg_first,
              AVG(EXTRACT(EPOCH FROM (resolved_at - COALESCE(chatwoot_created_at, created_at)))) AS avg_resolution
       FROM conversations WHERE account_id=$1 ${df.sql} ${agentWhere}
       GROUP BY agent ORDER BY COUNT(*) DESC LIMIT $${params.push(clamp(limit, 20, 1, 100))}`,
      params
    );
    let out = `### Agent SLA Metrics (${df.label})\n\n`;
    for (const r of rows) out += `- **${r.agent}** | handled: ${r.total} | first-response coverage: ${r.first_covered}/${r.total} | avg first response: ${duration(r.avg_first)} | avg resolution: ${duration(r.avg_resolution)}\n`;
    return text(out);
  });

  register(server, "get_agent_wrong_label_assignments", "QA heuristic: agents and resolved conversations where labels may be wrong based on transcript keywords.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional(),
    limit: z.number().int().default(25)
  }, async ({ account_id, days, limit }) => {
    const df = dateFilter("c.last_activity_at", { days }, 2);
    const rows = await queryRows<{ id: string; agent_name: string; labels: string[]; content: string }>(
      `SELECT c.id, COALESCE(c.agent_name, c.resolved_by, 'Unassigned') AS agent_name, c.labels, string_agg(cc.content, E'\n') AS content
       FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id
       WHERE c.account_id=$1 ${df.sql}
       GROUP BY c.id, agent_name, c.labels
       HAVING (array_to_string(c.labels, ',') NOT ILIKE '%billing%' AND string_agg(cc.content, E'\n') ILIKE '%invoice%')
           OR (array_to_string(c.labels, ',') NOT ILIKE '%technical%' AND string_agg(cc.content, E'\n') ILIKE '%not working%')
       ORDER BY c.id DESC LIMIT $${2 + df.params.length}`,
      [account_id, ...df.params, clamp(limit, 25, 1, 100)]
    );
    let out = `### Possible Wrong Label Assignments (${df.label})\n\n`;
    for (const r of rows) out += `- **Conv #${r.id}** | Agent: ${r.agent_name} | labels: ${(r.labels ?? []).join(", ") || "None"}\n  - Evidence: ${snippet(r.content, ["invoice", "not working", "billing", "technical"])}\n`;
    return text(rows.length ? out : out + "No suspected wrong labels found.");
  });

  register(server, "get_slow_conversations", "Find resolved conversations that were slow or show late first response, repeated follow-up, looping, waiting, or escalation signals.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(10),
    days: z.number().int().optional(),
    min_resolution_hours: z.number().int().optional()
  }, async ({ account_id, limit, days, min_resolution_hours }) => {
    const df = dateFilter("c.last_activity_at", { days }, 2);
    const params: unknown[] = [account_id, ...df.params];
    const min = min_resolution_hours ? `AND EXTRACT(EPOCH FROM (COALESCE(c.resolved_at, c.last_activity_at) - COALESCE(c.chatwoot_created_at, c.created_at))) >= $${params.push(min_resolution_hours * 3600)}` : "";
    const rows = await queryRows<Row>(
      `SELECT c.id, c.contact_name, COALESCE(c.agent_name, c.resolved_by) AS agent, c.labels,
              EXTRACT(EPOCH FROM (c.first_response_at - COALESCE(c.chatwoot_created_at, c.created_at))) AS first_seconds,
              EXTRACT(EPOCH FROM (COALESCE(c.resolved_at, c.last_activity_at) - COALESCE(c.chatwoot_created_at, c.created_at))) AS resolution_seconds,
              string_agg(cc.content, E'\n') AS transcript
       FROM conversations c LEFT JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id
       WHERE c.account_id=$1 ${df.sql} ${min}
       GROUP BY c.id ORDER BY resolution_seconds DESC NULLS LAST LIMIT $${params.push(clamp(limit, 10, 1, 100))}`,
      params
    );
    let out = `### Slow Resolved Conversations (${df.label})\n\n`;
    for (const r of rows) out += `- **Conv #${r.id}** (${r.contact_name ?? "Unknown"}) | Agent: ${r.agent ?? "Unassigned"} | first response: ${duration(r.first_seconds)} | resolution: ${duration(r.resolution_seconds)}\n  - Signal: ${snippet(String(r.transcript ?? ""), ["waiting", "delay", "again", "still", "manager"])}\n`;
    return text(out);
  });

  register(server, "get_resolved_conversations_with_unresolved_signals", "Resolved conversations where transcript suggests customer issue remained unresolved.", {
    account_id: z.number().int().default(1),
    label: z.string().optional(),
    channel: z.string().optional(),
    agent_name: z.string().optional(),
    limit: z.number().int().default(20),
    days: z.number().int().optional()
  }, async ({ account_id, label, channel, agent_name, limit, days }) => {
    const patterns = ["not solved", "not fixed", "still", "waiting", "no response", "refund", "cancel"];
    const df = dateFilter("c.last_activity_at", { days }, 2);
    const params: unknown[] = [account_id, ...df.params, ...patterns.map(likePattern)];
    const extra = [
      label ? `AND $${params.push(label)} = ANY(c.labels)` : "",
      channel ? `AND c.channel_type ILIKE $${params.push(likePattern(channel))}` : "",
      agent_name ? `AND (c.agent_name ILIKE $${params.push(likePattern(agent_name))} OR c.resolved_by ILIKE $${params.length})` : ""
    ].join(" ");
    const rows = await queryRows<Row>(
      `SELECT DISTINCT c.id, c.contact_name, COALESCE(c.agent_name, c.resolved_by) AS agent, c.labels, c.channel_type, cc.content
       FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id
       WHERE c.account_id=$1 ${df.sql} AND (${patterns.map((_, i) => `cc.content ILIKE $${2 + df.params.length + i}`).join(" OR ")}) ${extra}
       ORDER BY c.id DESC LIMIT $${params.push(clamp(limit, 20, 1, 100))}`,
      params
    );
    let out = `### Resolved Conversations With Unresolved-Issue Signals (${df.label})\n\n`;
    for (const r of rows) out += `- **Conv #${r.id}** | ${r.contact_name ?? "Unknown"} | Agent: ${r.agent ?? "Unassigned"} | Channel: ${r.channel_type ?? "N/A"}\n  - ${snippet(String(r.content), patterns)}\n`;
    return text(rows.length ? out : out + "No unresolved issue signals found.");
  });

  register(server, "get_agent_performance_report", "One-agent report with fuzzy name matching for misspellings, workload, SLA, issue mix, channel mix, slow conversations, and risk samples.", {
    account_id: z.number().int().default(1),
    agent_name: z.string().default(""),
    days: z.number().int().optional(),
    limit: z.number().int().default(20)
  }, async ({ account_id, agent_name, days, limit }) => {
    const df = dateFilter("last_activity_at", { days }, 3);
    const rows = await queryRows<Row>(
      `SELECT id, contact_name, labels, channel_type, first_response_at, resolved_at, chatwoot_created_at, created_at,
              EXTRACT(EPOCH FROM (first_response_at - COALESCE(chatwoot_created_at, created_at))) AS first_seconds,
              EXTRACT(EPOCH FROM (resolved_at - COALESCE(chatwoot_created_at, created_at))) AS resolution_seconds
       FROM conversations WHERE account_id=$1 AND (agent_name ILIKE $2 OR resolved_by ILIKE $2) ${df.sql}
       ORDER BY resolved_at DESC NULLS LAST LIMIT $${3 + df.params.length}`,
      [account_id, likePattern(agent_name), ...df.params, clamp(limit, 20, 1, 100)]
    );
    const avgFirst = rows.reduce((a, r) => a + n(r.first_seconds), 0) / Math.max(rows.filter((r) => r.first_seconds).length, 1);
    const avgRes = rows.reduce((a, r) => a + n(r.resolution_seconds), 0) / Math.max(rows.filter((r) => r.resolution_seconds).length, 1);
    let out = `### Agent Performance Report: ${agent_name} (${df.label})\n\n- Conversations handled: **${rows.length}**\n- Average first response: ${duration(avgFirst)}\n- Average resolution: ${duration(avgRes)}\n\n#### Recent Conversations\n`;
    for (const r of rows.slice(0, 10)) out += `- **#${r.id}** | ${r.contact_name ?? "Unknown"} | channel: ${r.channel_type ?? "N/A"} | labels: ${((r.labels as string[]) ?? []).join(", ") || "None"}\n`;
    return text(out);
  });
}

function registerProductReportTools(server: McpServer): void {
  const rawSnippetTool = (name: string, title: string, patterns: string[], intro: string) => {
    register(server, name, intro, {
      account_id: z.number().int().default(1),
      limit: z.number().int().default(10),
      days: z.number().int().optional()
    }, async ({ account_id, limit, days }) => {
      const df = dateFilter("c.last_activity_at", { days }, 2);
      const rows = await queryRows<Row>(
        `SELECT DISTINCT c.id, c.contact_name, c.agent_name, cc.content FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id WHERE c.account_id=$1 ${df.sql} AND (${patterns.map((_, i) => `cc.content ILIKE $${2 + df.params.length + i}`).join(" OR ")}) ORDER BY c.id DESC LIMIT $${2 + df.params.length + patterns.length}`,
        [account_id, ...df.params, ...patterns.map(likePattern), clamp(limit, 10, 1, 100)]
      );
      let out = `### ${title} (${df.label})\n\n`;
      for (const r of rows) out += `- **Conv #${r.id}** (${r.contact_name ?? "Unknown"}) | Agent: ${r.agent_name ?? "Unassigned"}\n  - ${snippet(String(r.content), patterns)}\n`;
      return text(rows.length ? out : out + "No snippets found.");
    });
  };

  rawSnippetTool("get_raw_feature_request_snippets", "Raw Feature Request Snippets", ["feature", "request", "need", "can you add", "would like", "missing"], "Pull raw cached resolved transcript snippets that look like feature requests.");
  rawSnippetTool("get_raw_product_pain_point_snippets", "Raw Product Pain Point Snippets", ["confusing", "difficult", "broken", "hard to use", "problem", "issue"], "Pull raw cached resolved transcript snippets mentioning product pain points.");
  rawSnippetTool("get_raw_bug_report_snippets", "Raw Bug Report Snippets", ["bug", "error", "fail", "failed", "not working", "broken"], "Pull raw cached resolved bug/error/not-working transcript snippets.");

  register(server, "cluster_feature_requests", "Product planning: cluster cached resolved feature-request conversations into ranked demand themes.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(10),
    days: z.number().int().optional()
  }, async ({ account_id, limit, days }) => groupedSignals(account_id, days, limit, [
    ["API / webhook / integration", ["api", "webhook", "integration"]],
    ["Billing/invoice flexibility", ["invoice", "billing", "payment"]],
    ["Dashboard/reporting", ["report", "dashboard", "export"]],
    ["Account/login access", ["login", "otp", "password"]]
  ], "Feature Request Themes"));

  register(server, "rank_bug_reports_by_frequency", "Engineering triage: group cached resolved bug/error/not-working conversations into ranked failure themes with severity.", {
    account_id: z.number().int().default(1),
    limit: z.number().int().default(10),
    days: z.number().int().optional()
  }, async ({ account_id, limit, days }) => groupedSignals(account_id, days, limit, [
    ["Login/OTP failure", ["login", "otp", "password"]],
    ["Payment/invoice failure", ["payment", "invoice", "billing"]],
    ["Service not working/down", ["not working", "down", "offline"]],
    ["API/webhook error", ["api", "webhook", "error"]]
  ], "Bug Report Themes"));

  async function groupedSignals(account_id: number, days: number | undefined, limit: number, groups: Array<[string, string[]]>, title: string): Promise<ToolResult> {
    const df = dateFilter("c.last_activity_at", { days }, 2);
    let out = `### ${title} (${df.label})\n\n`;
    for (const [label, patterns] of groups.slice(0, clamp(limit, 10, 1, 50))) {
      const rows = await queryRows<Row>(
        `SELECT DISTINCT c.id, c.contact_name, cc.content FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id WHERE c.account_id=$1 ${df.sql} AND (${patterns.map((_, i) => `cc.content ILIKE $${2 + df.params.length + i}`).join(" OR ")}) LIMIT 3`,
        [account_id, ...df.params, ...patterns.map(likePattern)]
      );
      if (!rows.length) continue;
      out += `#### ${label} (${rows.length}+ samples)\n`;
      for (const r of rows) out += `- Conv #${r.id} (${r.contact_name ?? "Unknown"}): ${snippet(String(r.content), patterns)}\n`;
    }
    return text(out);
  }

  register(server, "get_pain_point_resolution_status", "Compare recent vs previous cached resolved pain-point volume.", {
    account_id: z.number().int().default(1),
    days: z.number().int().optional()
  }, async ({ account_id, days }) => {
    const windowDays = days && days > 0 ? days : 14;
    const row = await queryOne<{ recent: string; previous: string }>(
      `SELECT COUNT(DISTINCT c.id) FILTER (WHERE c.last_activity_at >= NOW() - ($2::int * INTERVAL '1 day')) AS recent,
              COUNT(DISTINCT c.id) FILTER (WHERE c.last_activity_at BETWEEN NOW() - ($2::int * 2 * INTERVAL '1 day') AND NOW() - ($2::int * INTERVAL '1 day')) AS previous
       FROM conversations c JOIN conversation_chunks cc ON cc.account_id=c.account_id AND cc.conversation_id=c.id
       WHERE c.account_id=$1 AND (cc.content ILIKE '%confusing%' OR cc.content ILIKE '%difficult%' OR cc.content ILIKE '%broken%' OR cc.content ILIKE '%not working%')`,
      [account_id, windowDays]
    );
    const recent = n(row?.recent), previous = n(row?.previous);
    const trend = recent > previous ? "worsening" : recent < previous ? "improving" : "flat";
    return text(`### Pain Point Resolution Status\n\n- Recent ${windowDays} days: ${recent}\n- Previous ${windowDays} days: ${previous}\n- Estimated trend: **${trend}**\n`);
  });

  register(server, "generate_resolved_support_report_for_date_range", "Management report over an explicit inclusive date range. Includes inbox-wise breakdown.", {
    from_date: z.string(),
    to_date: z.string(),
    account_id: z.number().int().default(1),
    limit: z.number().int().default(10)
  }, async ({ from_date, to_date, account_id, limit }) => supportReport(account_id, from_date, to_date, limit));

  register(server, "generate_current_month_resolved_support_report", "Generate current calendar-month resolved support report.", {
    account_id: z.number().int().default(1)
  }, async ({ account_id }) => {
    const now = new Date();
    const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    return supportReport(account_id, start, now.toISOString().slice(0, 10), 10);
  });

  register(server, "generate_current_quarter_resolved_support_report", "Generate current calendar-quarter resolved support report.", {
    account_id: z.number().int().default(1)
  }, async ({ account_id }) => {
    const now = new Date();
    const month = now.getUTCMonth();
    const qStart = Math.floor(month / 3) * 3;
    const start = `${now.getUTCFullYear()}-${String(qStart + 1).padStart(2, "0")}-01`;
    return supportReport(account_id, start, now.toISOString().slice(0, 10), 10);
  });

  async function supportReport(account_id: number, from_date: string, to_date: string, limit: number): Promise<ToolResult> {
    const df = dateFilter("resolved_at", { from_date, to_date }, 2);
    const total = n((await queryOne<{ count: string }>(`SELECT COUNT(*) FROM conversations WHERE account_id=$1 ${df.sql}`, [account_id, ...df.params]))?.count);
    const labels = await queryRows<{ label: string; count: string }>(`SELECT label, COUNT(*) FROM (SELECT unnest(labels) AS label FROM conversations WHERE account_id=$1 AND status='resolved' ${df.sql}) sub GROUP BY label ORDER BY COUNT(*) DESC LIMIT $${2 + df.params.length}`, [account_id, ...df.params, clamp(limit, 10, 1, 50)]);
    const agents = await queryRows<{ agent: string; count: string }>(`SELECT COALESCE(agent_name, resolved_by, 'Unassigned') AS agent, COUNT(*) FROM conversations WHERE account_id=$1 AND status='resolved' ${df.sql} GROUP BY agent ORDER BY COUNT(*) DESC LIMIT $${2 + df.params.length}`, [account_id, ...df.params, clamp(limit, 10, 1, 50)]);
    const inboxes = await queryRows<{ inbox: string; channel: string; count: string }>(`SELECT COALESCE(inbox_name, 'Unknown Inbox') AS inbox, COALESCE(channel_type, 'Unknown') AS channel, COUNT(*) FROM conversations WHERE account_id=$1 AND status='resolved' ${df.sql} GROUP BY inbox, channel ORDER BY COUNT(*) DESC LIMIT $${2 + df.params.length}`, [account_id, ...df.params, clamp(limit, 10, 1, 50)]);
    let out = `### Resolved Support Report (Account ${account_id}, ${df.label})\n\n- **Date Basis:** latest cached resolution time (\`resolved_at\`) in ${config.reportTimezone}\n- **Resolved Conversations:** ${total}\n\n#### Top Labels\n`;
    for (const r of labels) out += `- **${r.label}**: ${r.count}\n`;
    out += "\n#### Agent Workload\n";
    for (const r of agents) out += `- **${r.agent}**: ${r.count}\n`;
    out += "\n#### Inbox-wise Breakdown\n";
    for (const r of inboxes) out += `- **${r.inbox}** (${r.channel}): ${r.count}\n`;
    return text(out);
  }

  register(server, "generate_weekly_resolved_team_leader_summary", "Team-leader weekly resolved-support summary. timeframe must be this_week or last_week.", {
    account_id: z.number().int().default(1),
    timeframe: z.enum(["this_week", "last_week"]).default("this_week")
  }, async ({ account_id, timeframe }) => {
    const now = new Date();
    const start = new Date(now);
    const day = start.getDay();
    const diffToSaturday = (day + 1) % 7;
    start.setDate(start.getDate() - diffToSaturday);
    if (timeframe === "last_week") start.setDate(start.getDate() - 7);
    const end = new Date(start);
    end.setDate(end.getDate() + 7);
    if (timeframe === "this_week") end.setTime(now.getTime());
    return supportReport(account_id, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10), 10);
  });

  register(server, "get_label_conversation_examples", "Cached resolved conversation examples for one specific label/category.", {
    issue_label: z.string(),
    account_id: z.number().int().default(1)
  }, async ({ issue_label, account_id }) => {
    const rows = await queryRows<Row>("SELECT id, contact_name, status, agent_name FROM conversations WHERE account_id=$1 AND $2 = ANY(labels) LIMIT 10", [account_id, issue_label]);
    return text(`### Issue Deep Dive Data: Tag "${issue_label}"\n\n` + rows.map((r) => `- **#${r.id}**: ${r.contact_name ?? "Unknown"} | Status: ${r.status ?? "N/A"} | Agent: ${r.agent_name ?? "Unassigned"}`).join("\n"));
  });

  register(server, "compare_chatwoot_accounts", "Side-by-side comparison of cached resolved Chatwoot accounts.", {
    account_ids: z.array(z.number().int()).optional(),
    days: z.number().int().optional()
  }, async ({ account_ids, days }) => {
    const accounts = account_ids?.length ? account_ids : (await queryRows<{ account_id: string }>("SELECT DISTINCT account_id FROM conversations ORDER BY account_id")).map((r) => Number(r.account_id));
    const df = dateFilter("resolved_at", { days }, 2);
    let out = `### Cross-Account Comparison (${df.label})\n\n`;
    for (const acc of accounts) {
      const total = n((await queryOne<{ count: string }>(`SELECT COUNT(*) FROM conversations WHERE account_id=$1 ${df.sql}`, [acc, ...df.params]))?.count);
      const topAgent = await queryOne<{ agent: string; count: string }>(`SELECT COALESCE(agent_name, resolved_by, 'Unassigned') AS agent, COUNT(*) FROM conversations WHERE account_id=$1 ${df.sql} GROUP BY agent ORDER BY COUNT(*) DESC LIMIT 1`, [acc, ...df.params]);
      const topLabel = await queryOne<{ label: string; count: string }>(`SELECT label, COUNT(*) FROM (SELECT unnest(labels) AS label FROM conversations WHERE account_id=$1 ${df.sql}) sub GROUP BY label ORDER BY COUNT(*) DESC LIMIT 1`, [acc, ...df.params]);
      out += `#### Account ${acc}\n- Conversations: ${total}\n- Top label: ${topLabel ? `${topLabel.label} (${topLabel.count})` : "N/A"}\n- Top agent: ${topAgent ? `${topAgent.agent} (${topAgent.count})` : "N/A"}\n\n`;
    }
    return text(out);
  });

  register(server, "get_first_response_time_report", "Account-level first-response timing from cached Chatwoot timestamps.", {
    account_id: z.number().int().default(1)
  }, async ({ account_id }) => timingReport(account_id, "first_response_at", "First Response Timing Report"));

  register(server, "get_resolution_time_report", "Account-level resolution timing from cached resolved Chatwoot timestamps.", {
    account_id: z.number().int().default(1)
  }, async ({ account_id }) => timingReport(account_id, "resolved_at", "Resolution Timing Report"));

  async function timingReport(account_id: number, column: "first_response_at" | "resolved_at", title: string): Promise<ToolResult> {
    const row = await queryOne<{ total: string; covered: string; avg_seconds: string; median_seconds: string }>(
      `SELECT COUNT(*) AS total, COUNT(${column}) AS covered,
              AVG(EXTRACT(EPOCH FROM (${column} - COALESCE(chatwoot_created_at, created_at)))) AS avg_seconds,
              PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${column} - COALESCE(chatwoot_created_at, created_at)))) AS median_seconds
       FROM conversations WHERE account_id=$1`,
      [account_id]
    );
    const total = n(row?.total), covered = n(row?.covered);
    return text(`### ${title}\n\n- **Timestamp Coverage:** ${covered}/${total} (${pct(covered, total)})\n- **Average:** ${duration(row?.avg_seconds)}\n- **Median:** ${duration(row?.median_seconds)}\n`);
  }
}
