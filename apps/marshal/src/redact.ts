// Stage-1 redaction (per the runtime contract): Marshal scrubs every sensitive value it
// handed to the build (org token, registry auth, webhook token, presigned URLs) from build
// logs before serving or persisting them. The values are assembled in
// services.ts::buildLogRedactionValues; the presigned URL signature is scrubbed by shape in
// redactBuildLogText. The backend applies stage 2 for its own secrets.
export function redactSecrets(text: string, secretValues: string[]): string {
  const values = [...new Set(secretValues.filter((value) => value.length > 0))];
  if (values.length === 0) return text;

  // Aho-Corasick finds every secret in one pass over the ORIGINAL log. Sequential
  // split/join redaction re-scanned `<redacted>` itself, so tenant-chosen one-character
  // secrets could multiply a 1 MiB log into gigabytes and exhaust the shared process.
  type MatcherNode = { next: Map<string, number>, failure: number, matchLength: number };
  const nodes: MatcherNode[] = [{ next: new Map(), failure: 0, matchLength: 0 }];
  for (const value of values) {
    let state = 0;
    for (let index = 0; index < value.length; index++) {
      const character = value[index];
      let next = nodes[state].next.get(character);
      if (next === undefined) {
        next = nodes.length;
        nodes[state].next.set(character, next);
        nodes.push({ next: new Map(), failure: 0, matchLength: 0 });
      }
      state = next;
    }
    nodes[state].matchLength = Math.max(nodes[state].matchLength, value.length);
  }

  const queue: number[] = [];
  for (const child of nodes[0].next.values()) queue.push(child);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const state = queue[cursor];
    for (const [character, child] of nodes[state].next) {
      queue.push(child);
      let fallback = nodes[state].failure;
      while (fallback !== 0 && !nodes[fallback].next.has(character)) fallback = nodes[fallback].failure;
      nodes[child].failure = nodes[fallback].next.get(character) ?? 0;
      nodes[child].matchLength = Math.max(nodes[child].matchLength, nodes[nodes[child].failure].matchLength);
    }
  }

  const matches: { start: number, end: number }[] = [];
  let state = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    while (state !== 0 && !nodes[state].next.has(character)) state = nodes[state].failure;
    state = nodes[state].next.get(character) ?? 0;
    const matchLength = nodes[state].matchLength;
    if (matchLength === 0) continue;
    let start = index + 1 - matchLength;
    let end = index + 1;
    while (matches.length > 0 && matches[matches.length - 1].end >= start) {
      const previous = matches.pop();
      if (previous === undefined) throw new Error("redaction interval disappeared");
      start = Math.min(start, previous.start);
      end = Math.max(end, previous.end);
    }
    matches.push({ start, end });
  }
  if (matches.length === 0) return text;

  const replacement = "<redacted>";
  const truncated = "<truncated>";
  // Never let redaction allocate materially more than the already-held input. Small logs get
  // a 1 MiB floor so ordinary short-secret replacement remains readable rather than truncated.
  const maxOutputLength = Math.max(text.length, 1024 * 1024);
  const projectedLength = text.length + matches.reduce((growth, match) => growth + replacement.length - (match.end - match.start), 0);
  const outputLimit = projectedLength > maxOutputLength ? maxOutputLength - truncated.length : maxOutputLength;
  const output: string[] = [];
  let outputLength = 0;
  let inputOffset = 0;
  const append = (value: string): void => {
    if (outputLength >= outputLimit) return;
    const remaining = outputLimit - outputLength;
    const chunk = value.length <= remaining ? value : value.slice(0, remaining);
    output.push(chunk);
    outputLength += chunk.length;
  };
  for (const match of matches) {
    append(text.slice(inputOffset, match.start));
    append(replacement);
    inputOffset = match.end;
  }
  append(text.slice(inputOffset));
  if (projectedLength > maxOutputLength) output.push(truncated);
  return output.join("");
}
