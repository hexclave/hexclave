import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "./errors.js";
import { DEFAULT_UPLOAD_DEADLINE_MS, formatBytes, formatDuration, formatRate, uploadDeadlineMs, uploadSource, uploadSourceMultipart } from "./source-upload.js";

// A stand-in for the object store. `bytesPerSecond` throttles how fast it
// DRAINS the request body, which is the whole point of these tests: the failure
// this module exists to fix is a wall-clock one, invisible on a fast link.
type ServerOptions = {
  status?: number,
  body?: string,
  bytesPerSecond?: number,
  // Accept the body and then never answer: a server that went quiet AFTER the
  // upload finished, which is a deadline case rather than a stall.
  neverRespond?: boolean,
  // Stop draining the body entirely once this many bytes are in, so the
  // client's writes stop flushing — a stall DURING the upload.
  stopReadingAfterBytes?: number,
  // Answer on the headers without reading the body at all: a proxy or CDN
  // refusing (or accepting) an upload before it has one.
  respondBeforeReadingBody?: boolean,
};

const servers: http.Server[] = [];

type StartedServer = {
  url: string,
  received: () => number,
  requestHeaders: () => http.IncomingHttpHeaders,
  close: () => void,
};

async function startServer(options: ServerOptions = {}): Promise<StartedServer> {
  let received = 0;
  let requestHeaders: http.IncomingHttpHeaders = {};
  const server = http.createServer((request, response) => {
    requestHeaders = request.headers;
    if (options.respondBeforeReadingBody === true) {
      response.writeHead(options.status ?? 200, { "content-type": "text/plain" });
      response.end(options.body ?? "");
      return;
    }
    const startedAt = Date.now();
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (options.stopReadingAfterBytes !== undefined && received >= options.stopReadingAfterBytes) {
        request.pause();
        return;
      }
      if (options.bytesPerSecond === undefined) return;
      // Hold the socket back until the clock catches up with the rate we allow.
      const owed = (received / options.bytesPerSecond) * 1000 - (Date.now() - startedAt);
      if (owed <= 0) return;
      request.pause();
      setTimeout(() => request.resume(), owed);
    });
    request.on("error", () => {});
    request.on("end", () => {
      if (options.neverRespond === true) return;
      response.writeHead(options.status ?? 200, { "content-type": "text/plain" });
      response.end(options.body ?? "");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/upload`,
    received: () => received,
    requestHeaders: () => requestHeaders,
    close: () => server.close(),
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const body = (megabytes: number) => new Uint8Array(Math.round(megabytes * 1024 * 1024));

// A store that drops the first `resetAttempts` connections mid-body and takes
// the next one — the shape of the link this retry loop exists for. Raw TCP
// rather than http.Server because the failure being modelled is a RST partway
// through the body, which a well-behaved server has no way to send.
type FlakyServer = {
  url: string,
  attempts: () => number,
  received: () => number,
  close: () => void,
};

const rawServers: net.Server[] = [];

function startFlakyServer(options: { resetAttempts: number, resetAfterBytes?: number, status?: number }): Promise<FlakyServer> {
  let attempts = 0;
  let received = 0;
  const resetAfterBytes = options.resetAfterBytes ?? 256 * 1024;
  const server = net.createServer((socket) => {
    attempts += 1;
    const doomed = attempts <= options.resetAttempts;
    let head = Buffer.alloc(0);
    let headerEnd = -1;
    let contentLength = 0;
    let bodySeen = 0;
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (headerEnd < 0) {
        head = Buffer.concat([head, chunk]);
        headerEnd = head.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const headers = head.subarray(0, headerEnd).toString("utf-8");
        contentLength = Number(/content-length: (\d+)/i.exec(headers)?.[1] ?? "0");
        bodySeen = head.length - (headerEnd + 4);
      } else {
        bodySeen += chunk.length;
      }
      if (doomed && bodySeen >= resetAfterBytes) {
        socket.resetAndDestroy();
        return;
      }
      if (bodySeen >= contentLength) {
        socket.end(`HTTP/1.1 ${options.status ?? 200} OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
      }
    });
  });
  rawServers.push(server);
  return new Promise<FlakyServer>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`,
      attempts: () => attempts,
      received: () => received,
      close: () => server.close(),
    }));
  });
}

afterEach(() => {
  for (const server of rawServers.splice(0)) server.close();
});


describe("uploading the packaged source", () => {
  it("PUTs the whole body with the signed headers", async () => {
    const server = await startServer();
    const bytes = body(3);
    await uploadSource({ uploadUrl: server.url, contentType: "application/gzip", bytes });
    expect(server.received()).toBe(bytes.byteLength);
    // Both headers are signed into the presigned URL; a mismatch is a 403 from
    // the real store, which no test server would catch.
    expect(server.requestHeaders()["content-type"]).toBe("application/gzip");
    expect(server.requestHeaders()["content-length"]).toBe(String(bytes.byteLength));
  });

  it("finishes a slow upload that outlives every clock a fast one would meet", async () => {
    // THE REGRESSION, scaled down. On global fetch this shape dies with
    // `TypeError: fetch failed` / UND_ERR_HEADERS_TIMEOUT once the body takes
    // more than five minutes to push, because undici arms headersTimeout when
    // the request is written and nothing resets it while the body uploads. A
    // 300s test is not a test anyone runs, so what is asserted here is the
    // property that made it fail: an upload that takes many times longer than
    // the timeouts in play still completes.
    const server = await startServer({ bytesPerSecond: 256 * 1024 });
    const bytes = body(1);
    const startedAt = Date.now();
    await uploadSource({ uploadUrl: server.url, contentType: "application/gzip", bytes, stallTimeoutMs: 1_500 });
    const elapsed = Date.now() - startedAt;
    // Took longer than the stall timeout it ran with, several times over: a
    // progressing upload must never be mistaken for a dead one, however slow.
    expect(elapsed).toBeGreaterThan(3_000);
    expect(server.received()).toBe(bytes.byteLength);
  }, 30_000);

  it("keeps a very slow upload alive by chunking finely enough to prove liveness", async () => {
    // Regression guard on the WRITE_CHUNK_BYTES / stall-timeout relationship: a
    // flush callback is the only liveness signal, so a chunk that takes longer
    // than the stall timeout to flush reads as a dead connection. With 1 MB
    // chunks this exact case false-failed at ~17 KB/s.
    const server = await startServer({ bytesPerSecond: 64 * 1024 });
    const bytes = body(0.35);
    await uploadSource({ uploadUrl: server.url, contentType: "application/gzip", bytes, stallTimeoutMs: 1_500 });
    expect(server.received()).toBe(bytes.byteLength);
  }, 30_000);

  it("gives up at the deadline, and says how far it got and how fast", async () => {
    // The reported bug, in miniature: a body too big to push before the clock
    // runs out. What differs from the fetch version is not that it fails — it
    // is that the failure names the upload, the numbers and the cause.
    const server = await startServer({ bytesPerSecond: 256 * 1024 });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(4),
      deadlineMs: 1_500,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("Uploading the packaged source timed out after 2s");
    // How far it got, out of how much, and the throughput that explains it.
    // The rate is what was FLUSHED, so socket buffering can make it read faster
    // than the wire; the point is that a number is there at all.
    expect(message).toMatch(/[\d.]+ MB of 4\.0 MB in [\d.]+s \(about [\d.]+ [KM]B\/s\)/);
    expect(message).toContain(".gitignore/.dockerignore");
  }, 30_000);

  it("blames the connection, not the slot, when the deadline is not the slot's expiry", async () => {
    // The slot outlives the deadline on both the upper clamp and the default,
    // so "the upload slot expires after that" would tell the user their upload
    // was impossible when retrying it would have worked.
    const server = await startServer({ bytesPerSecond: 256 * 1024 });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(4),
      expiresAtMillis: Date.now() + 6 * 60 * 60 * 1000,
      deadlineMs: 1_000,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("timed out");
    expect(message).toContain("connection may be too slow");
    expect(message).not.toContain("upload slot expires");
  }, 30_000);

  it("prefers an explicit deadline over the slot expiry", async () => {
    const server = await startServer({ bytesPerSecond: 256 * 1024 });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(4),
      // An hour of slot left, but the caller said one second.
      expiresAtMillis: Date.now() + 60 * 60 * 1000,
      deadlineMs: 1_000,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("timed out");
  }, 30_000);

  it("reports a non-2xx from object storage with the store's own explanation", async () => {
    const server = await startServer({ status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code></Error>" });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(1),
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("403 from object storage");
    expect((error as CliError).message).toContain("SignatureDoesNotMatch");
  });

  it("names a stall mid-upload, with the bytes, instead of a bare TypeError", async () => {
    // The peer stops reading and never comes back: a connection that died
    // without a reset — a suspended laptop, a dropped NAT mapping.
    const server = await startServer({ stopReadingAfterBytes: 128 * 1024 });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(24),
      stallTimeoutMs: 1_000,
      deadlineMs: 15_000,
      maxAttempts: 1,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("stalled");
    expect(message).toContain("no data was sent for 1s");
    // It stopped part-way, and says so — the number is the diagnosis.
    expect(message).toMatch(/of 24\.0 MB in [\d.]+s/);
    expect(message).toContain("Check your network connection");
  }, 30_000);

  it("waits out a silent server until the DEADLINE, never on inactivity", async () => {
    // The design decision this module exists for, pinned: once the body is
    // written the client is idle by definition, and ending that wait on
    // inactivity is exactly undici's headersTimeout bug. Only the deadline may
    // end it — so this fails with the deadline message, not the stall one,
    // even though the stall timeout is far shorter.
    const server = await startServer({ neverRespond: true });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(1),
      stallTimeoutMs: 300,
      deadlineMs: 2_000,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("timed out after 2s");
    expect((error as CliError).message).not.toContain("stalled");
  }, 30_000);

  it("names a refused connection rather than letting a TypeError escape", async () => {
    const server = await startServer();
    const url = server.url;
    server.close();
    // Give the listener a moment to actually stop accepting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const error = await uploadSource({
      uploadUrl: url,
      contentType: "application/gzip",
      bytes: body(0.1),
      maxAttempts: 1,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("The source upload failed");
    expect(message).toMatch(/ECONNREFUSED|ECONNRESET/);
    // A connection that never opened has no progress worth reporting; "0 B of
    // 100.0 KB in 0s" would be noise dressed as a diagnosis.
    expect(message).not.toContain("0 B of");
  });

  it("names a middlebox that resets mid-upload, and the byte it died on", async () => {
    // THE REPORTED SYMPTOM. A proxy with an upload cap that RSTs instead of
    // answering fails in milliseconds and only above its cap — which is why a
    // smaller repository "fixed" it. On fetch this is a bare
    // `TypeError: fetch failed`, naming neither the upload nor the size.
    const cap = 2 * 1024 * 1024;
    const rude = net.createServer((socket) => {
      let seen = 0;
      socket.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > cap) socket.resetAndDestroy();
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => rude.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(rude.address() as AddressInfo).port}/upload`;
    try {
      const error = await uploadSource({
        uploadUrl: url,
        contentType: "application/gzip",
        bytes: body(16),
        deadlineMs: 15_000,
        maxAttempts: 1,
      }).catch((e: unknown) => e as CliError);
      expect(error).toBeInstanceOf(CliError);
      const message = (error as CliError).message;
      expect(message).toContain("The source upload failed");
      expect(message).toMatch(/ECONNRESET|EPIPE/);
      // The byte it died on is the whole diagnosis: it points at a size cap
      // between the client and the store rather than at a slow link.
      expect(message).toMatch(/of 16\.0 MB/);
    } finally {
      rude.close();
    }
  }, 20_000);

  it("refuses a 2xx that arrives before the body was sent", async () => {
    // REGRESSION: a store or proxy that answers on the headers used to RESOLVE
    // this in milliseconds having sent a fraction of the tarball. The deploy
    // then referenced an upload whose object was truncated, and died minutes
    // later in the builder saying nothing about the upload.
    const server = await startServer({ respondBeforeReadingBody: true, status: 200 });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(24),
      deadlineMs: 15_000,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).toContain("did not receive the whole source");
    expect(message).toContain("of 24.0 MB");
    expect(message).toContain("proxy or upload size limit");
  }, 30_000);

  it("still refuses a non-2xx that arrives before the body was sent", async () => {
    // The size-cap case with a well-behaved middlebox: the status is what the
    // user needs, so it must survive rather than becoming the truncation error.
    const server = await startServer({ respondBeforeReadingBody: true, status: 413, body: "<Error><Code>EntityTooLarge</Code></Error>" });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(24),
      deadlineMs: 15_000,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("413 from object storage");
    expect((error as CliError).message).toContain("EntityTooLarge");
  }, 30_000);

  it("reports a failed CONNECT as a connection error, never as a stall", async () => {
    // REGRESSION: the stall timer used to be armed before the first flush, so a
    // connection that never opened was reported as "no data was sent for 1s,
    // after 0 B of 1.0 MB" — the exact noise the error path strips on purpose.
    // Connecting is the deadline's to bound.
    const server = await startServer();
    const url = server.url;
    server.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const error = await uploadSource({
      uploadUrl: url,
      contentType: "application/gzip",
      bytes: body(1),
      stallTimeoutMs: 300,
      deadlineMs: 15_000,
      maxAttempts: 1,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    expect(message).not.toContain("stalled");
    expect(message).toMatch(/ECONNREFUSED|ECONNRESET/);
  }, 30_000);

  it("rejects a URL that is not one it can PUT to", async () => {
    await expect(uploadSource({ uploadUrl: "not a url", contentType: "application/gzip", bytes: body(0.01) }))
      .rejects.toThrow(/invalid object-storage upload URL/);
    await expect(uploadSource({ uploadUrl: "ftp://example.com/x", contentType: "application/gzip", bytes: body(0.01) }))
      .rejects.toThrow(/unsupported protocol/);
  });
});

describe("retrying an upload the link dropped", () => {
  it("re-sends the whole tarball after a dropped connection and finishes", async () => {
    // THE REPORTED FAILURE. A 30 MB source over a link that RSTs one connection
    // in a handful used to lose the entire upload and fail the deploy; the same
    // bytes go up again and land.
    const server = await startFlakyServer({ resetAttempts: 1 });
    const retries: number[] = [];
    await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(1),
      deadlineMs: 20_000,
      retryBaseDelayMs: 10,
      onRetry: ({ attempt }) => retries.push(attempt),
    });
    expect(server.attempts()).toBe(2);
    // Reported, not silent: a retry re-sends everything, which on a real source
    // is minutes in which the CLI would otherwise look hung.
    expect(retries).toEqual([1]);
  }, 30_000);

  it("keeps going across several drops", async () => {
    const server = await startFlakyServer({ resetAttempts: 3 });
    await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(1),
      deadlineMs: 20_000,
      retryBaseDelayMs: 10,
    });
    expect(server.attempts()).toBe(4);
  }, 30_000);

  it("gives up after the last attempt, and says how many it made", async () => {
    const server = await startFlakyServer({ resetAttempts: Number.MAX_SAFE_INTEGER });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(1),
      deadlineMs: 20_000,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    const message = (error as CliError).message;
    // The last attempt's own diagnosis survives — the count is added to it, not
    // instead of it.
    expect(message).toMatch(/ECONNRESET|EPIPE/);
    expect(message).toContain("Gave up after 3 attempts.");
    expect(server.attempts()).toBe(3);
  }, 30_000);

  it("does not retry a rejection the same bytes would earn again", async () => {
    // A bad signature, an oversize body: deterministic. Re-sending 30 MB four
    // more times to be told the same thing is worse than failing at once.
    const server = await startServer({ status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code></Error>" });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(0.5),
      retryBaseDelayMs: 10,
    }).catch((e: unknown) => e as CliError);
    expect((error as CliError).message).toContain("403 from object storage");
    // One attempt, so no count is appended.
    expect((error as CliError).message).not.toContain("Gave up after");
  }, 30_000);

  it("retries a 5xx, which is the store having a moment rather than a bad request", async () => {
    const server = await startFlakyServer({ resetAttempts: 0, status: 503 });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(0.5),
      deadlineMs: 20_000,
      maxAttempts: 2,
      retryBaseDelayMs: 10,
    }).catch((e: unknown) => e as CliError);
    expect((error as CliError).message).toContain("Gave up after 2 attempts.");
    expect(server.attempts()).toBe(2);
  }, 30_000);

  it("does not retry a middlebox that answers without taking the body", async () => {
    const server = await startServer({ respondBeforeReadingBody: true, status: 200 });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(4),
      deadlineMs: 20_000,
      retryBaseDelayMs: 10,
    }).catch((e: unknown) => e as CliError);
    expect((error as CliError).message).toContain("did not receive the whole source");
    expect((error as CliError).message).not.toContain("Gave up after");
  }, 30_000);

  it("spends ONE deadline across every attempt, not a fresh one each time", async () => {
    // REGRESSION GUARD. Arming the full deadline per attempt would let a
    // retrying upload run for maxAttempts times the life of a slot that died
    // after the first — pushing bytes at a URL that cannot accept them.
    const server = await startFlakyServer({ resetAttempts: Number.MAX_SAFE_INTEGER });
    const startedAt = Date.now();
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(1),
      deadlineMs: 2_000,
      maxAttempts: 50,
      retryBaseDelayMs: 200,
    }).catch((e: unknown) => e as CliError);
    const elapsed = Date.now() - startedAt;
    expect(error).toBeInstanceOf(CliError);
    // Bounded by the one budget, with room for the attempt that was in flight
    // when it ran out — nowhere near 50 x 2s.
    expect(elapsed).toBeLessThan(8_000);
    expect(server.attempts()).toBeLessThan(50);
  }, 30_000);

  it("reports the failure that happened, not the deadline, when the clock runs out between attempts", async () => {
    // Swapping a useful "the connection was reset at 27 MB" for a bare "timed
    // out" would hide the actual diagnosis behind the budget it exhausted.
    const server = await startFlakyServer({ resetAttempts: Number.MAX_SAFE_INTEGER });
    const error = await uploadSource({
      uploadUrl: server.url,
      contentType: "application/gzip",
      bytes: body(1),
      deadlineMs: 1_500,
      maxAttempts: 50,
      retryBaseDelayMs: 5_000,
    }).catch((e: unknown) => e as CliError);
    const message = (error as CliError).message;
    expect(message).toMatch(/ECONNRESET|EPIPE/);
    expect(message).not.toContain("timed out after");
  }, 30_000);
});

// A store that speaks enough of the S3 multipart protocol to exercise the
// client: a PUT with ?partNumber stores a part and answers with an ETag, a POST
// completes, a DELETE aborts. `dropEveryNthPart` RSTs the given part uploads
// once each, which is the failure the whole design exists for.
type MultipartStore = {
  partUrl: (part: number) => string,
  completeUrl: string,
  abortUrl: string,
  partBytes: () => Map<number, number>,
  completedXml: () => string | null,
  aborted: () => boolean,
  partAttempts: () => number,
};

function startMultipartStore(options: { dropParts?: number[], completeStatus?: number, completeBody?: string } = {}): Promise<MultipartStore> {
  const partBytes = new Map<number, number>();
  const dropped = new Set<number>();
  let completedXml: string | null = null;
  let aborted = false;
  let partAttempts = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const part = Number(url.searchParams.get("partNumber") ?? "0");
    if (request.method === "DELETE") {
      aborted = true;
      response.writeHead(204).end();
      return;
    }
    let received = 0;
    const body: Buffer[] = [];
    if (request.method === "PUT") partAttempts += 1;
    request.on("error", () => {});
    request.on("data", (chunk: Buffer) => {
      received += chunk.length;
      body.push(chunk);
      // Kill this part's first attempt only, so a retry can succeed.
      if (request.method === "PUT" && options.dropParts?.includes(part) === true && !dropped.has(part) && received > 1024) {
        dropped.add(part);
        request.socket.resetAndDestroy();
      }
    });
    request.on("end", () => {
      if (request.method === "POST") {
        completedXml = Buffer.concat(body).toString("utf-8");
        response.writeHead(options.completeStatus ?? 200, { "content-type": "application/xml" });
        response.end(options.completeBody ?? "<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
        return;
      }
      partBytes.set(part, received);
      // The ETag is what the client must collect and send back on complete.
      response.writeHead(200, { etag: `"etag-${part}"` });
      response.end();
    });
  });
  servers.push(server);
  return new Promise<MultipartStore>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upload`;
      resolve({
        partUrl: (part) => `${base}?partNumber=${part}&uploadId=test`,
        completeUrl: `${base}?uploadId=test`,
        abortUrl: `${base}?uploadId=test`,
        partBytes: () => partBytes,
        completedXml: () => completedXml,
        aborted: () => aborted,
        partAttempts: () => partAttempts,
      });
    });
  });
}

const PART_SIZE = 1024 * 1024;

function multipartSlot(store: MultipartStore, partCount: number) {
  return {
    part_size_bytes: PART_SIZE,
    part_urls: Array.from({ length: partCount }, (_unused, index) => store.partUrl(index + 1)),
    complete_url: store.completeUrl,
    abort_url: store.abortUrl,
  };
}

describe("uploading the source in parts", () => {
  it("splits the source, collects an ETag per part, and completes with the part list", async () => {
    const store = await startMultipartStore();
    // 2.5 parts: the last one is deliberately short, which is the only size S3
    // and R2 allow to differ.
    const bytes = new Uint8Array(PART_SIZE * 2 + 512);
    await uploadSourceMultipart({
      uploadUrl: "http://unused.invalid/single",
      contentType: "application/gzip",
      bytes,
      deadlineMs: 30_000,
      retryBaseDelayMs: 10,
      multipart: multipartSlot(store, 3),
    });
    expect([...store.partBytes().entries()].sort((a, b) => a[0] - b[0])).toEqual([[1, PART_SIZE], [2, PART_SIZE], [3, 512]]);
    const xml = store.completedXml();
    // Part numbers are 1-based and in order, each with the ETag the store gave
    // for that part — an off-by-one here assembles a corrupt object.
    expect(xml).toContain("<PartNumber>1</PartNumber><ETag>&#34;etag-1&#34;</ETag>");
    expect(xml).toContain("<PartNumber>3</PartNumber><ETag>&#34;etag-3&#34;</ETag>");
    expect(store.aborted()).toBe(false);
  }, 30_000);

  it("re-sends only the part that dropped, not the whole source", async () => {
    // THE POINT OF ALL THIS. A drop costs one part; the other parts are not
    // re-uploaded, which is what makes a big source land on a lossy link.
    const store = await startMultipartStore({ dropParts: [2] });
    const bytes = new Uint8Array(PART_SIZE * 3);
    await uploadSourceMultipart({
      uploadUrl: "http://unused.invalid/single",
      contentType: "application/gzip",
      bytes,
      deadlineMs: 30_000,
      retryBaseDelayMs: 10,
      multipart: multipartSlot(store, 3),
    });
    // Three parts plus exactly one re-send.
    expect(store.partAttempts()).toBe(4);
    expect(store.completedXml()).toContain("<PartNumber>2</PartNumber>");
  }, 30_000);

  it("names the part that failed", async () => {
    const store = await startMultipartStore({ dropParts: [2] });
    const error = await uploadSourceMultipart({
      uploadUrl: "http://unused.invalid/single",
      contentType: "application/gzip",
      bytes: new Uint8Array(PART_SIZE * 2),
      deadlineMs: 30_000,
      maxAttempts: 1,
      retryBaseDelayMs: 10,
      multipart: multipartSlot(store, 2),
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("Part 2 of 2:");
    expect((error as CliError).message).toMatch(/ECONNRESET|EPIPE/);
  }, 30_000);

  it("aborts the upload when it gives up, rather than leaving parts billing", async () => {
    const store = await startMultipartStore({ dropParts: [1] });
    await uploadSourceMultipart({
      uploadUrl: "http://unused.invalid/single",
      contentType: "application/gzip",
      bytes: new Uint8Array(PART_SIZE),
      deadlineMs: 30_000,
      maxAttempts: 1,
      retryBaseDelayMs: 10,
      multipart: multipartSlot(store, 1),
    }).catch(() => undefined);
    expect(store.aborted()).toBe(true);
  }, 30_000);

  it("treats a 200 carrying an <Error> document as a failed assembly", async () => {
    // R2 and S3 both answer CompleteMultipartUpload with 200 and an <Error>
    // body when the assembly fails. Trusting the status would report a deploy
    // whose source object does not exist.
    const store = await startMultipartStore({
      completeStatus: 200,
      completeBody: "<Error><Code>InvalidPart</Code></Error>",
    });
    const error = await uploadSourceMultipart({
      uploadUrl: "http://unused.invalid/single",
      contentType: "application/gzip",
      bytes: new Uint8Array(PART_SIZE),
      deadlineMs: 30_000,
      retryBaseDelayMs: 10,
      multipart: multipartSlot(store, 1),
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("could not assemble");
    expect((error as CliError).message).toContain("InvalidPart");
    expect(store.aborted()).toBe(true);
  }, 30_000);

  it("refuses a slot whose part count does not match the source", async () => {
    // A mismatch would silently upload a truncated object: the parts that were
    // offered would all succeed and complete would assemble a short tarball.
    const store = await startMultipartStore();
    const error = await uploadSourceMultipart({
      uploadUrl: "http://unused.invalid/single",
      contentType: "application/gzip",
      bytes: new Uint8Array(PART_SIZE * 3),
      deadlineMs: 30_000,
      multipart: multipartSlot(store, 2),
    }).catch((e: unknown) => e as CliError);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("offered 2 upload parts for a source that needs 3");
    expect(store.partBytes().size).toBe(0);
  }, 30_000);
});


describe("the upload deadline", () => {
  const now = 1_000_000;

  it("is the slot's own expiry, because a dead URL cannot be written to", () => {
    expect(uploadDeadlineMs(now + 10 * 60 * 1000, now)).toBe(10 * 60 * 1000);
  });

  it("falls back when the API did not say", () => {
    expect(uploadDeadlineMs(null, now)).toBe(DEFAULT_UPLOAD_DEADLINE_MS);
    expect(uploadDeadlineMs(undefined, now)).toBe(DEFAULT_UPLOAD_DEADLINE_MS);
    expect(uploadDeadlineMs(Number.NaN, now)).toBe(DEFAULT_UPLOAD_DEADLINE_MS);
  });

  it("falls back to the default when the slot reads as expired, rather than to the floor", () => {
    // REGRESSION: this used to clamp UP to the 60s floor, which is SHORTER than
    // the default — so a client whose clock had drifted got a harsher deadline
    // than one the API had told nothing, on exactly the slow upload this module
    // exists to keep alive. A slot minted seconds ago with fifteen minutes of
    // life cannot really be expired; a skewed client clock is the explanation.
    expect(uploadDeadlineMs(now - 60_000, now)).toBe(DEFAULT_UPLOAD_DEADLINE_MS);
    // Implausibly-soon reads the same way.
    expect(uploadDeadlineMs(now + 5_000, now)).toBe(DEFAULT_UPLOAD_DEADLINE_MS);
  });

  it("clamps an implausibly distant expiry, so a misconfiguration cannot hang the CLI", () => {
    expect(uploadDeadlineMs(now + 6 * 60 * 60 * 1000, now)).toBe(30 * 60 * 1000);
  });

  it("is comfortably more than undici's 300s, which is the whole point", () => {
    expect(DEFAULT_UPLOAD_DEADLINE_MS).toBeGreaterThan(300_000);
  });
});

describe("the numbers an upload failure reports", () => {
  it("formats sizes the way a reader states them", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(39 * 1024 * 1024)).toBe("39.0 MB");
  });

  it("formats durations past a minute as minutes and seconds", () => {
    expect(formatDuration(45_000)).toBe("45s");
    // A connection cut in milliseconds must not read as "0s".
    expect(formatDuration(420)).toBe("0.4s");
    expect(formatDuration(300_000)).toBe("5m00s");
    expect(formatDuration(905_000)).toBe("15m05s");
  });

  it("states throughput, which is what tells a user it is their link and not the tool", () => {
    // 28 MB in 300s is the boundary the reported bug sat on.
    expect(formatRate(28 * 1024 * 1024, 300_000)).toBe("95.6 KB/s");
    expect(formatRate(0, 1_000)).toBeNull();
    expect(formatRate(1_000, 0)).toBeNull();
    // Too short a sample to be throughput: 9.7 MB flushed into a socket buffer
    // in 40ms is not a 240 MB/s link, and printing that helps nobody.
    expect(formatRate(9_700_000, 40)).toBeNull();
  });
});
