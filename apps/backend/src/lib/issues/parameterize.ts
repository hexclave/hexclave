
import { truncateUtf8Bytes } from "@hexclave/shared/dist/utils/analytics-wire";
import { isRecord } from "@hexclave/shared/dist/utils/objects";

const MAX_MESSAGE_BYTES = 8 * 1024;

const PARAMETERIZE_RE = new RegExp(
  [
    String.raw`(?<url>\b[a-z][a-z0-9+.\-]*:\/\/[^\s"'<>()\[\]]+)`,
    String.raw`(?<email>[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})`,
    String.raw`(?<uuid>\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b)`,
    String.raw`(?<date>\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+\-]\d{2}:?\d{2})?)?)`,
    String.raw`(?<ipv6>(?<![0-9a-f:])(?:` +
      String.raw`(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|` +
      String.raw`(?:[0-9a-f]{1,4}:){1,7}:|` +
      String.raw`(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|` +
      String.raw`(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|` +
      String.raw`(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|` +
      String.raw`(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|` +
      String.raw`(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|` +
      String.raw`[0-9a-f]{1,4}:(?:(?::[0-9a-f]{1,4}){1,6})|` +
      String.raw`:(?:(?::[0-9a-f]{1,4}){1,7}|:)` +
    String.raw`)(?![0-9a-f:]))`,
    String.raw`(?<ipv4>\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b)`,
    String.raw`(?<hex>\b(?:0x[0-9a-f]+|[0-9a-f]{8,})\b)`,
    String.raw`(?<float>\b\d+\.\d+)`,
    String.raw`(?<int>\b\d+)`,
  ].join("|"),
  "gi",
);

const PLACEHOLDERS: ReadonlyMap<string, string> = new Map([
  ["url", "<url>"],
  ["email", "<email>"],
  ["uuid", "<uuid>"],
  ["date", "<date>"],
  ["ipv6", "<ip>"],
  ["ipv4", "<ip>"],
  ["hex", "<hex>"],
  ["float", "<float>"],
  ["int", "<int>"],
]);

export function parameterizeMessage(message: string): string {
  const bounded = truncateUtf8Bytes(message, MAX_MESSAGE_BYTES);
  return bounded.replace(PARAMETERIZE_RE, (match, ...args) => {
    const groups: unknown = args.at(-1);
    if (!isRecord(groups)) return match;
    for (const [name, placeholder] of PLACEHOLDERS) {
      if (typeof groups[name] === "string") return placeholder;
    }
    return match;
  });
}
