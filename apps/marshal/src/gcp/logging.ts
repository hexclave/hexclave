import type { LogLine } from "../types.js";
import { GcpClient } from "./client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function entryText(entry: Record<string, unknown>): string {
  if (typeof entry.textPayload === "string") return entry.textPayload.replace(/\n$/, "");
  if (entry.jsonPayload !== undefined) return JSON.stringify(entry.jsonPayload);
  if (typeof entry.protoPayload === "string") return entry.protoPayload;
  return "";
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function parseEntries(value: unknown): LogLine[] {
  if (!isRecord(value) || value.entries === undefined) return [];
  if (!Array.isArray(value.entries)) throw new Error("Cloud Logging returned an invalid entries list");
  return value.entries.flatMap((raw): LogLine[] => {
    if (!isRecord(raw)) return [];
    const atMillis = parseTimestamp(raw.timestamp);
    if (atMillis === null) return [];
    const labels = isRecord(raw.labels) ? raw.labels : {};
    const resource = isRecord(raw.resource) && isRecord(raw.resource.labels) ? raw.resource.labels : {};
    const logName = typeof raw.logName === "string" ? raw.logName : "";
    return [{
      at_millis: atMillis,
      stream: logName.endsWith("%2Fstderr") || logName.endsWith("/stderr") ? "stderr" : "stdout",
      instance: typeof labels.instanceId === "string"
        ? labels.instanceId
        : typeof resource.instance_id === "string" ? resource.instance_id : null,
      text: entryText(raw),
    }];
  });
}

export class GcpLoggingClient {
  constructor(
    private readonly client: GcpClient,
    private readonly projectId: string,
  ) {}

  private async entries(filter: string): Promise<LogLine[]> {
    const result = await this.client.request("https://logging.googleapis.com/v2/entries:list", {
      method: "POST",
      body: {
        resourceNames: [`projects/${this.projectId}`],
        filter,
        orderBy: "timestamp asc",
        pageSize: 1000,
      },
    });
    return parseEntries(result);
  }

  async cloudRunService(serviceName: string, sinceMillis?: number): Promise<LogLine[]> {
    const filter = [
      'resource.type="cloud_run_revision"',
      `resource.labels.service_name=${filterString(serviceName)}`,
      ...(sinceMillis === undefined ? [] : [`timestamp>=${filterString(new Date(sinceMillis).toISOString())}`]),
    ].join(" AND ");
    return await this.entries(filter);
  }

  async computeInstance(instanceId: string, sinceMillis?: number): Promise<LogLine[]> {
    const filter = [
      'resource.type="gce_instance"',
      `resource.labels.instance_id=${filterString(instanceId)}`,
      ...(sinceMillis === undefined ? [] : [`timestamp>=${filterString(new Date(sinceMillis).toISOString())}`]),
    ].join(" AND ");
    return await this.entries(filter);
  }
}
