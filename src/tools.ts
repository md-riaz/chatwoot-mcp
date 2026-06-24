import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chatwootGet, extractAccounts, extractCollection } from "./chatwoot.js";
import { config, reportTimezoneOffset } from "./config.js";
import { dateWindowClause, reportTimestamp } from "./dates.js";
import { queryOne, queryRows } from "./db.js";

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

  return server;
}
