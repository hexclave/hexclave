import dns from "node:dns";
import http from "node:http";
import { expect, it } from "vitest";
import { requestWithDnsLookup } from "./core";

async function requestStatus(status: number) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  try {
    const address = server.address();
    if (address == null || typeof address === "string") {
      throw new Error("The test endpoint must listen on a TCP port");
    }
    const url = new URL("http://127.0.0.1");
    url.port = String(address.port);
    return await requestWithDnsLookup(url, {
      method: "POST",
      headers: new Headers(),
      signal: AbortSignal.timeout(2000),
      lookup: dns.lookup,
      maxResponseBytes: 64 * 1024,
      description: "Test endpoint",
    });
  } finally {
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error == null ? resolveClose() : rejectClose(error));
    });
  }
}

it.each([600, 700, 999])("rejects unsupported HTTP status %i without an uncaught exception", async (status) => {
  await expect(requestStatus(status)).rejects.toThrow("Test endpoint returned an unsupported HTTP status.");
});

it.each([200, 204, 205, 304, 400, 599])("accepts HTTP status %i", async (status) => {
  expect((await requestStatus(status)).status).toBe(status);
});
