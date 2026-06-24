import { config } from "./config.js";

export async function chatwootGet<T = unknown>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> {
  if (!config.chatwootBaseUrl || !config.chatwootApiToken) {
    throw new Error("CHATWOOT_BASE_URL or CHATWOOT_API_TOKEN is not configured");
  }

  const url = new URL(path, config.chatwootBaseUrl.replace(/\/+$/, "") + "/");
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, {
    headers: { api_access_token: config.chatwootApiToken }
  });
  if (!response.ok) {
    throw new Error(`Chatwoot API ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export function extractCollection(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return extractCollection(value, keys);
    if (value && typeof value === "object") {
      const nested = extractCollection(value, keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

export function extractAccounts(payload: unknown): Array<{ id: number | string; name: string; role?: string }> {
  const found = new Map<string, { id: number | string; name: string; role?: string }>();

  function add(candidate: unknown, role?: string): void {
    if (!candidate || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    const account = record.account && typeof record.account === "object" ? (record.account as Record<string, unknown>) : record;
    const id = account.id ?? account.account_id;
    const name = account.name ?? account.account_name;
    if (id === undefined || name === undefined) return;
    found.set(`${id}`, { id: id as number | string, name: String(name), role: role ?? (String(record.role ?? "") || undefined) });
  }

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    for (const key of ["accounts", "account_users", "account_memberships"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        for (const item of value) add(item);
      }
    }
    if (record.data) walk(record.data);
  }

  walk(payload);
  return [...found.values()].sort((a, b) => Number(a.id) - Number(b.id));
}
