import { config } from "./config.js";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function localOffset(): string {
  if (config.reportTimezone === "Asia/Dhaka") return "+06:00";
  return "+00:00";
}

function parseBoundary(value: string, endOfDay: boolean): Date {
  const text = String(value).trim();
  if (DATE_ONLY.test(text)) {
    const time = endOfDay ? "23:59:59.999" : "00:00:00.000";
    return new Date(`${text}T${time}${localOffset()}`);
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("date must be ISO date/datetime or unix timestamp");
  }
  return parsed;
}

export function reportTimestamp(value: string, endOfDay = false): string {
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return text;
  return Math.floor(parseBoundary(text, endOfDay).getTime() / 1000).toString();
}

export function dateWindowClause(
  column: string,
  options: { days?: number; from_date?: string; to_date?: string }
): { sql: string; params: unknown[]; label: string } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const labelParts: string[] = [];

  if (options.from_date) {
    clauses.push(`${column} >= $${params.length + 1}`);
    params.push(parseBoundary(options.from_date, false).toISOString());
    labelParts.push(`from ${options.from_date}`);
  }
  if (options.to_date) {
    clauses.push(`${column} <= $${params.length + 1}`);
    params.push(parseBoundary(options.to_date, true).toISOString());
    labelParts.push(`to ${options.to_date}`);
  }
  if (clauses.length) {
    return {
      sql: `AND ${clauses.join(" AND ")}`,
      params,
      label: `${labelParts.join(" ")} (${config.reportTimezone})`
    };
  }

  if (!options.days || options.days <= 0) {
    return { sql: "", params: [], label: "All Cached History" };
  }
  return {
    sql: `${column} >= NOW() - ($1::int * INTERVAL '1 day')`,
    params: [options.days],
    label: `Last ${options.days} Days`
  };
}
