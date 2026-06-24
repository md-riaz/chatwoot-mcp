import "dotenv/config";

export type AppConfig = {
  port: number;
  basePath: string;
  mcpApiKey?: string;
  chatwootBaseUrl?: string;
  chatwootApiToken?: string;
  reportTimezone: string;
  databaseUrl?: string;
  db: {
    host: string;
    port: number;
    database: string;
    user?: string;
    password?: string;
  };
};

export function normalizeBasePath(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (!value || value === "/") return "";
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return prefixed.replace(/\/+$/, "");
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? "3000"),
  basePath: normalizeBasePath(process.env.BASE_PATH),
  mcpApiKey: process.env.MCP_API_KEY,
  chatwootBaseUrl: process.env.CHATWOOT_BASE_URL,
  chatwootApiToken: process.env.CHATWOOT_API_TOKEN,
  reportTimezone: process.env.CHATWOOT_REPORT_TIMEZONE ?? "Asia/Dhaka",
  databaseUrl: process.env.DATABASE_URL,
  db: {
    host: process.env.INTELLIGENCE_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.INTELLIGENCE_DB_PORT ?? "5432"),
    database: process.env.INTELLIGENCE_DB_NAME ?? "chatwoot_intelligence",
    user: process.env.INTELLIGENCE_DB_USER,
    password: process.env.INTELLIGENCE_DB_PASSWORD
  }
};

export function reportTimezoneOffset(): string {
  if (config.reportTimezone === "Asia/Dhaka") return "+06:00";
  return "+00:00";
}
