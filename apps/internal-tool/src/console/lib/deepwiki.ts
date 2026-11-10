/**
 * Asks DeepWiki's public MCP endpoint about the Hexclave repo, to pre-fill a human correction.
 * Same request the legacy correction card makes (components/CallLogDetail.tsx keeps its own
 * unexported copy; this one is shared by the console). The endpoint answers over SSE, so the JSON
 * payload is on the first `data:` line.
 */
export async function fetchDeepWikiAnswer(question: string): Promise<string> {
  const res = await fetch("https://mcp.deepwiki.com/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_question", arguments: { repoName: "hexclave/hexclave", question } },
    }),
  });
  if (!res.ok) throw new Error(`DeepWiki returned ${res.status}`);

  const dataLine = (await res.text()).split("\n").find(line => line.startsWith("data: "));
  if (dataLine == null) throw new Error("DeepWiki response contained no data");
  const payload: unknown = JSON.parse(dataLine.slice("data: ".length));
  const content = typeof payload === "object" && payload != null && "result" in payload
    && typeof payload.result === "object" && payload.result != null && "content" in payload.result
    ? payload.result.content
    : null;
  if (!Array.isArray(content)) throw new Error("DeepWiki response had an unexpected shape");
  const text = content
    .flatMap(part => typeof part === "object" && part != null && "text" in part && typeof part.text === "string" ? [part.text] : [])
    .join("\n\n");
  if (text === "") throw new Error("DeepWiki returned an empty answer");
  return text;
}
