import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chatwootGet, extractAccounts, extractCollection } from "./chatwoot.js";
import { config, reportTimezoneOffset } from "./config.js";
import { dateWindowClause, reportTimestamp } from "./dates.js";
import { queryOne, queryRows } from "./db.js";
import { registerParityTools } from "./parityTools.js";

type ConversationSummaryRow = {
  account_id: number;
  conversation_id: number;
  contact_name: string | null;
  contact_email: string | null;
  inbox_id: number | null;
  inbox_name: string | null;
  channel_type: string | null;
  agent_name: string | null;
  labels: string[] | null;
  resolved_by: string | null;
  chatwoot_created_at: Date | string | null;
  last_activity_at: Date | string | null;
  resolved_at: Date | string | null;
  transcript: string | null;
};

function text(markdown: string) {
  return { content: [{ type: "text" as const, text: markdown }] };
}

function pct(value: number, total: number): string {
  if (!total) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

function numberValue(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return Number(value);
  return 0;
}

function compactText(value: unknown, maxChars = 700): string {
  const output = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars - 1).trimEnd()}...`;
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function summarizeTranscript(transcript: string | null): string {
  if (!transcript) return "No cached transcript chunk available.";
  const lines = transcript
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^conversation\s*#/i.test(line));
  return compactText(lines.join(" "), 900) || "No readable transcript text available.";
}

export function createChatwootMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "chatwoot-mcp",
      version: "0.1.0"
    },
    {
      instructions:
        "Chatwoot MCP read-only analytics server. Default to cached resolved-conversation tools. Before choosing account_id or inbox_id for account, brand, product, service, inbox, or channel queries, call list_available_chatwoot_scope first. Phrase 'live chat' means WebWidget/Live Chat inboxes, not live/open data. Use native/live tools only when the user explicitly asks for Chatwoot UI/native/live/open/all-status report numbers."
    }
  );

  server.registerTool(
    "list_available_chatwoot_accounts",
    {
      title: "List Chatwoot Accounts",
      description:
        "Use to list Chatwoot accounts/workspaces accessible with CHATWOOT_API_TOKEN plus cached conversation coverage. Use before account-scoped reports when account_id is uncertain.",
      inputSchema: {}
    },
    async () => {
      const cacheRows = await queryRows<{ account_id: string; conversations: string; latest_activity: Date | null }>(
        "SELECT account_id, COUNT(*) AS conversations, MAX(last_activity_at) AS latest_activity FROM conversations GROUP BY account_id ORDER BY account_id"
      );
      const cached = new Map(cacheRows.map((row) => [String(row.account_id), row]));

      let accounts: Array<{ id: number | string; name: string; role?: string }> = [];
      try {
        accounts = extractAccounts(await chatwootGet("/api/v1/profile"));
      } catch {
        accounts = cacheRows.map((row) => ({ id: row.account_id, name: `Account ${row.account_id}` }));
      }

      let out = "### Available Chatwoot Accounts / Brands\n\n";
      out += "Use the returned `account_id` in the next account-scoped MCP tool call.\n\n";
      for (const account of accounts) {
        const cache = cached.get(String(account.id));
        const role = account.role ? ` | role: ${account.role}` : "";
        const cacheText = cache
          ? ` | cached conversations: ${cache.conversations} | latest cached activity: ${cache.latest_activity ?? "N/A"}`
          : "";
        out += `- **${account.name}** -> \`account_id=${account.id}\`${role}${cacheText}\n`;
      }
      return text(out);
    }
  );

  server.registerTool(
    "list_available_chatwoot_scope",
    {
      title: "List Chatwoot Scope Map",
      description:
        "Use first before deciding account_id/inbox_id when user mentions any account, brand, product, service, inbox, channel, Facebook, Messenger, WhatsApp, live chat, or ambiguous brand-like term. Lists account/workspace and all live inbox names/IDs/channels.",
      inputSchema: {
        account_id: z.number().int().optional(),
        limit_per_account: z.number().int().min(1).max(300).default(100)
      }
    },
    async ({ account_id, limit_per_account }) => {
      const accounts = account_id
        ? [{ id: account_id, name: `Account ${account_id}` }]
        : extractAccounts(await chatwootGet("/api/v1/profile"));

      let out = "### Available Chatwoot Scope Map\n\n";
      out += "Pick exact `account_id` and `inbox_id` values from these real names before scoped analytics.\n\n";
      for (const account of accounts) {
        const data = await chatwootGet(`/api/v1/accounts/${account.id}/inboxes`);
        const inboxes = extractCollection(data, ["payload", "inboxes"]).slice(0, limit_per_account);
        out += `#### ${account.name} (\`account_id=${account.id}\`)\n\n`;
        out += "| Inbox | ID | Channel |\n| - | -: | - |\n";
        for (const inbox of inboxes) {
          const channel = String(inbox.channel_type ?? (inbox.channel as Record<string, unknown> | undefined)?.type ?? "N/A");
          out += `| ${String(inbox.name ?? "Unnamed")} | ${String(inbox.id ?? "N/A")} | ${channel} |\n`;
        }
        out += "\n";
      }
      return text(out);
    }
  );

  server.registerTool(
    "get_cache_sync_status",
    {
      title: "Get Cache Sync Status",
      description:
        "Use to check MCP cache freshness, latest synced Chatwoot activity, vector coverage, contact identity coverage, and SLA timestamp coverage.",
      inputSchema: {
        account_id: z.number().int().optional()
      }
    },
    async ({ account_id }) => {
      const params: unknown[] = [];
      const where = account_id ? "WHERE c.account_id = $1" : "";
      if (account_id) params.push(account_id);
      const rows = await queryRows<{
        account_id: string;
        conversations: string;
        vectorized: string;
        chunks: string;
        cache_updated_at: Date | null;
        latest_activity: Date | null;
        contact_covered: string;
        first_response_covered: string;
        resolved_at_covered: string;
      }>(
        `
        SELECT c.account_id,
               COUNT(DISTINCT c.id) AS conversations,
               COUNT(DISTINCT c.id) FILTER (WHERE c.last_message_id_embedded > 0) AS vectorized,
               COUNT(cc.id) AS chunks,
               MAX(c.updated_at) AS cache_updated_at,
               MAX(c.last_activity_at) AS latest_activity,
               COUNT(DISTINCT c.id) FILTER (WHERE c.contact_id IS NOT NULL OR c.contact_email IS NOT NULL) AS contact_covered,
               COUNT(DISTINCT c.id) FILTER (WHERE c.first_response_at IS NOT NULL) AS first_response_covered,
               COUNT(DISTINCT c.id) FILTER (WHERE c.resolved_at IS NOT NULL) AS resolved_at_covered
        FROM conversations c
        LEFT JOIN conversation_chunks cc ON cc.account_id = c.account_id AND cc.conversation_id = c.id
        ${where}
        GROUP BY c.account_id
        ORDER BY c.account_id
        `,
        params
      );

      let out = "### Cache Sync Status\n\n";
      for (const row of rows) {
        const total = numberValue(row.conversations);
        const vectorized = numberValue(row.vectorized);
        const contact = numberValue(row.contact_covered);
        const first = numberValue(row.first_response_covered);
        const resolved = numberValue(row.resolved_at_covered);
        out += `#### Account ${row.account_id}\n`;
        out += `- Conversations cached: ${total}\n`;
        out += `- Vectorized: ${vectorized} (${pct(vectorized, total)}) | Chunks: ${row.chunks}\n`;
        out += `- Last cache update: ${row.cache_updated_at ?? "N/A"}\n`;
        out += `- Latest Chatwoot activity in cache: ${row.latest_activity ?? "N/A"}\n`;
        out += `- Contact identity coverage: ${contact}/${total} (${pct(contact, total)})\n`;
        out += `- First-response timestamp coverage: ${first}/${total} (${pct(first, total)})\n`;
        out += `- Resolved-at timestamp coverage: ${resolved}/${total} (${pct(resolved, total)})\n\n`;
      }
      return text(rows.length ? out : "No cached conversations found.");
    }
  );

  server.registerTool(
    "get_resolved_conversation_volume_by_inbox",
    {
      title: "Resolved Conversation Volume By Inbox",
      description:
        "Use by default for account-level or one inbox/channel chat-count questions over cached resolved conversations. Date filters use latest cached resolved_at and count unique conversations, not repeated resolution events.",
      inputSchema: {
        account_id: z.number().int().default(1),
        inbox_id: z.number().int().optional(),
        inbox_name: z.string().optional(),
        days: z.number().int().optional(),
        from_date: z.string().optional(),
        to_date: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25)
      }
    },
    async ({ account_id, inbox_id, inbox_name, days, from_date, to_date, limit }) => {
      const window = dateWindowClause("resolved_at", { days, from_date, to_date });
      const filters = ["account_id = $1", "status = 'resolved'"];
      const params: unknown[] = [account_id];
      if (inbox_id !== undefined) {
        params.push(inbox_id);
        filters.push(`inbox_id = $${params.length}`);
      }
      if (inbox_name) {
        params.push(`%${inbox_name}%`);
        filters.push(`inbox_name ILIKE $${params.length}`);
      }
      const adjustedWindow = window.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + params.length}`);
      params.push(...window.params, limit);

      const rows = await queryRows<{
        inbox: string;
        inbox_id: string | null;
        resolved_count: string;
        first_resolved: Date | null;
        latest_resolved: Date | null;
      }>(
        `
        SELECT COALESCE(inbox_name, 'Unknown Inbox') AS inbox,
               inbox_id,
               COUNT(*) AS resolved_count,
               MIN(resolved_at) AS first_resolved,
               MAX(resolved_at) AS latest_resolved
        FROM conversations
        WHERE ${filters.join(" AND ")}
          ${adjustedWindow}
        GROUP BY inbox, inbox_id
        ORDER BY resolved_count DESC, inbox ASC
        LIMIT $${params.length}
        `,
        params
      );

      let out = `### Resolved Conversation Volume by Inbox (${window.label})\n\n`;
      out += `Date-limited counts use latest cached resolution time (\`resolved_at\`) in ${config.reportTimezone}. Counts are unique cached conversations grouped by stored/final inbox metadata, not repeated resolution events.\n\n`;
      for (const row of rows) {
        out += `- **${row.inbox}** | id: \`${row.inbox_id ?? "N/A"}\` | resolved conversations: **${row.resolved_count}** | resolved: ${row.first_resolved ?? "N/A"} to ${row.latest_resolved ?? "N/A"}\n`;
      }
      return text(rows.length ? out : `No cached resolved conversations found in ${window.label}.`);
    }
  );

  server.registerTool(
    "get_daily_resolved_conversation_volume",
    {
      title: "Daily Resolved Conversation Volume",
      description:
        "Use to show cached resolved Chatwoot conversation volume by report timezone day based on latest cached resolution timestamp.",
      inputSchema: {
        account_id: z.number().int().default(1)
      }
    },
    async ({ account_id }) => {
      const rows = await queryRows<{ day: Date; count: string }>(
        `
        SELECT date_trunc('day', resolved_at AT TIME ZONE $1) AS day, COUNT(*)
        FROM conversations
        WHERE account_id = $2 AND status = 'resolved' AND resolved_at IS NOT NULL
        GROUP BY day
        ORDER BY day DESC
        LIMIT 15
        `,
        [config.reportTimezone, account_id]
      );
      let out = `### Conversation Daily Volume Report (${config.reportTimezone})\n\n`;
      out += "Counts use latest cached resolution time (`resolved_at`) and count unique cached conversations, not repeated resolution events.\n\n";
      for (const row of rows) out += `- **${String(row.day).slice(0, 10)}**: ${row.count} conversations\n`;
      return text(out);
    }
  );

  server.registerTool(
    "get_chatwoot_native_report",
    {
      title: "Chatwoot Native Report",
      description:
        "Use only when user explicitly needs live/current/open/all-statuses Chatwoot UI report numbers or benchmarking against native reports. Native resolutions_count counts resolution events, not unique conversations.",
      inputSchema: {
        account_id: z.number().int().default(1),
        report_type: z.string().default("account"),
        metric: z.string().default("conversations_count"),
        since: z.string(),
        until: z.string(),
        id: z.string().optional(),
        business_hours: z.boolean().optional(),
        timezone_offset: z.string().optional()
      }
    },
    async ({ account_id, report_type, metric, since, until, id, business_hours, timezone_offset }) => {
      const params: Record<string, string | number | boolean | undefined> = {
        type: report_type,
        metric,
        since: reportTimestamp(since, false),
        until: reportTimestamp(until, true),
        id,
        timezone_offset: timezone_offset ?? reportTimezoneOffset()
      };
      if (business_hours !== undefined) params.business_hours = business_hours;
      const data = await chatwootGet(`/api/v2/accounts/${account_id}/reports`, params);
      let out = `### Chatwoot Native Report (Account ${account_id})\n\n`;
      out += "- Source: live Chatwoot read-only v2 reports API\n";
      out += `- Type: \`${report_type}\` | Metric: \`${metric}\` | Since: \`${params.since}\` | Until: \`${params.until}\`\n`;
      out += `- Timezone offset: \`${params.timezone_offset}\`\n`;
      if (metric === "resolutions_count") {
        out += "- Count basis: Chatwoot native resolution events; repeated resolves on one conversation may count more than once.\n";
      }
      out += `\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
      return text(out);
    }
  );

  server.registerTool(
    "get_recent_resolved_conversation_summaries_by_inbox",
    {
      title: "Get recent resolved conversation summaries by inbox",
      description:
        "Return cached resolved conversations from the last N days grouped by account and inbox, including each Chatwoot conversation ID and a compact transcript-based summary. Use this for prompts like 'last 7 days all conversations summary per inbox', 'summarize conversations with IDs by inbox', or recent resolved chat audit. This uses cached resolved conversations; do not use for currently open/live backlog unless user explicitly asks for live/open data. If user mentions account, brand, inbox, product, or channel, call list_available_chatwoot_scope first, then pass selected account_id and/or inbox_ids.",
      inputSchema: {
        days: z.number().int().min(1).max(366).describe("Number of days back from now to include. Required because this tool is specifically for last N days requests."),
        account_id: z.number().int().optional().describe("Optional Chatwoot account ID selected after list_available_chatwoot_scope."),
        inbox_ids: z.array(z.number().int()).optional().describe("Optional inbox IDs selected after list_available_chatwoot_scope. For a brand, include all matching inboxes such as Messenger, WhatsApp, and Live Chat."),
        max_conversations_per_inbox: z.number().int().min(1).max(500).optional().describe("Maximum conversations returned per inbox. Default 100."),
        include_transcript_excerpt: z.boolean().optional().describe("Include compact transcript excerpt used for summary. Default false.")
      }
    },
    async ({
      days,
      account_id,
      inbox_ids,
      max_conversations_per_inbox,
      include_transcript_excerpt
    }: {
      days: number;
      account_id?: number;
      inbox_ids?: number[];
      max_conversations_per_inbox?: number;
      include_transcript_excerpt?: boolean;
    }) => {
      const params: unknown[] = [days];
      const filters = ["c.resolved_at IS NOT NULL", "c.resolved_at >= NOW() - ($1::int * INTERVAL '1 day')"];

      if (typeof account_id === "number") {
        params.push(account_id);
        filters.push(`c.account_id = $${params.length}::bigint`);
      }

      if (inbox_ids && inbox_ids.length > 0) {
        params.push(inbox_ids);
        filters.push(`c.inbox_id = ANY($${params.length}::bigint[])`);
      }

      params.push(max_conversations_per_inbox ?? 100);
      const limitParam = params.length;

      const rows = await queryRows<ConversationSummaryRow>(
        `
          WITH conversations_with_text AS (
            SELECT
              c.account_id,
              c.id AS conversation_id,
              c.contact_name,
              c.contact_email,
              c.inbox_id,
              c.inbox_name,
              c.channel_type,
              c.agent_name,
              c.labels,
              c.resolved_by,
              c.chatwoot_created_at,
              c.last_activity_at,
              c.resolved_at,
              STRING_AGG(cc.content, E'\\n\\n' ORDER BY cc.chunk_index) AS transcript
            FROM conversations c
            LEFT JOIN conversation_chunks cc
              ON cc.account_id = c.account_id
             AND cc.conversation_id = c.id
            WHERE ${filters.join(" AND ")}
            GROUP BY
              c.account_id,
              c.id,
              c.contact_name,
              c.contact_email,
              c.inbox_id,
              c.inbox_name,
              c.channel_type,
              c.agent_name,
              c.labels,
              c.resolved_by,
              c.chatwoot_created_at,
              c.last_activity_at,
              c.resolved_at
          ),
          ranked AS (
            SELECT
              *,
              ROW_NUMBER() OVER (
                PARTITION BY account_id, inbox_id
                ORDER BY resolved_at DESC NULLS LAST, conversation_id DESC
              ) AS inbox_rank
            FROM conversations_with_text
          )
          SELECT *
          FROM ranked
          WHERE inbox_rank <= $${limitParam}::int
          ORDER BY account_id ASC, inbox_name ASC NULLS LAST, inbox_id ASC NULLS LAST, resolved_at DESC NULLS LAST;
        `,
        params
      );

      const grouped = new Map<string, {
        account_id: number;
        inbox_id: number | null;
        inbox_name: string;
        channel_type: string | null;
        conversation_count: number;
        conversations: unknown[];
      }>();

      for (const row of rows) {
        const key = `${row.account_id}:${row.inbox_id ?? "unknown"}`;
        const inbox = grouped.get(key) ?? {
          account_id: row.account_id,
          inbox_id: row.inbox_id,
          inbox_name: row.inbox_name ?? "Unknown inbox",
          channel_type: row.channel_type,
          conversation_count: 0,
          conversations: []
        };
        inbox.conversation_count += 1;
        inbox.conversations.push({
          conversation_id: row.conversation_id,
          contact_name: row.contact_name,
          contact_email: row.contact_email,
          agent_name: row.agent_name,
          resolved_by: row.resolved_by,
          labels: row.labels ?? [],
          chatwoot_created_at: formatDate(row.chatwoot_created_at),
          last_activity_at: formatDate(row.last_activity_at),
          resolved_at: formatDate(row.resolved_at),
          summary: summarizeTranscript(row.transcript),
          ...(include_transcript_excerpt ? { transcript_excerpt: compactText(row.transcript, 1600) } : {})
        });
        grouped.set(key, inbox);
      }

      return text(JSON.stringify({
        source: "cached_resolved_conversations",
        window: {
          days,
          from: `now - ${days} days`,
          to: "now"
        },
        filters: {
          account_id: account_id ?? null,
          inbox_ids: inbox_ids ?? null
        },
        total_conversations: rows.length,
        inbox_count: grouped.size,
        inboxes: Array.from(grouped.values())
      }, null, 2));
    }
  );

  registerParityTools(server);

  return server;
}
