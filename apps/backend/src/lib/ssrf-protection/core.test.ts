import dns from "node:dns";
import http from "node:http";
import { expect, it } from "vitest";
import { requestWithDnsLookup } from "./core";

async function requestFromTestServer(options: {
  status: number,
  responseBodyBytes?: number,
  responseBody: Parameters<typeof requestWithDnsLookup>[1]["responseBody"],
}) {
  const server = http.createServer((_req, res) => {
    res.writeHead(options.status);
    res.end(options.responseBodyBytes === undefined ? undefined : Buffer.alloc(options.responseBodyBytes, "a"));
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
      responseBody: options.responseBody,
      description: "Test endpoint",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error == null ? resolveClose() : rejectClose(error));
    });
  }
}

async function requestStatus(status: number) {
  return await requestFromTestServer({ status, responseBody: { type: "buffered", maxBytes: 64 * 1024 } });
}

it.each([600, 700, 999])("rejects unsupported HTTP status %i without an uncaught exception", async (status) => {
  await expect(requestStatus(status)).rejects.toThrow("Test endpoint returned an unsupported HTTP status.");
});

it.each([200, 204, 205, 304, 400, 599])("accepts HTTP status %i", async (status) => {
  expect((await requestStatus(status)).status).toBe(status);
});

it("rejects buffered responses that exceed the maximum size", async () => {
  await expect(requestFromTestServer({
    status: 200,
    responseBodyBytes: 1024 * 1024,
    responseBody: { type: "buffered", maxBytes: 64 * 1024 },
  })).rejects.toThrow("Test endpoint response exceeded the maximum allowed size.");
});

it("resolves with the status and no body in status-only mode, even for large responses", async () => {
  const response = await requestFromTestServer({
    status: 200,
    responseBodyBytes: 1024 * 1024,
    responseBody: { type: "status-only" },
  });
  expect(response.status).toBe(200);
  expect(response.body).toBeNull();
});

it("rejects unsupported HTTP statuses in status-only mode", async () => {
  await expect(requestFromTestServer({ status: 600, responseBody: { type: "status-only" } }))
    .rejects.toThrow("Test endpoint returned an unsupported HTTP status.");
});
