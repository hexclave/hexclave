import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException, type PutObjectCommandInput } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { ignoreUnhandledRejection, wait } from "@hexclave/shared/dist/utils/promises";
import { ImageProcessingError, parseBase64Image } from "./lib/images";
import { getOptionalRequestAbortSignal } from "./lib/runtime/request-context";

const S3_REGION = getEnvVariable("STACK_S3_REGION", "");
const S3_ENDPOINT = getEnvVariable("STACK_S3_ENDPOINT", "");
const S3_PUBLIC_ENDPOINT = getEnvVariable("STACK_S3_PUBLIC_ENDPOINT", "");
const S3_BUCKET = getEnvVariable("STACK_S3_BUCKET", "");
const S3_PRIVATE_BUCKET = getEnvVariable("STACK_S3_PRIVATE_BUCKET", "");
const S3_ACCESS_KEY_ID = getEnvVariable("STACK_S3_ACCESS_KEY_ID", "");
const S3_SECRET_ACCESS_KEY = getEnvVariable("STACK_S3_SECRET_ACCESS_KEY", "");

const HAS_S3 = !!S3_REGION && !!S3_ENDPOINT && !!S3_BUCKET && !!S3_ACCESS_KEY_ID && !!S3_SECRET_ACCESS_KEY;

if (!HAS_S3) {
  console.warn("S3 bucket is not configured. File upload features will not be available.");
}

if (HAS_S3 && !S3_PRIVATE_BUCKET) {
  console.warn("S3 private bucket is not configured (STACK_S3_PRIVATE_BUCKET). Session recordings and deployment source uploads will not be available.");
}

const s3Client = HAS_S3 ? new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
}) : undefined;

export function getS3PublicUrl(key: string): string {
  if (S3_PUBLIC_ENDPOINT) {
    return `${S3_PUBLIC_ENDPOINT}/${key}`;
  } else {
    return `${S3_ENDPOINT}/${S3_BUCKET}/${key}`;
  }
}

export async function uploadBytes(options: {
  key: string,
  body: Uint8Array,
  contentType?: string,
  contentEncoding?: string,
  private?: boolean,
}) {
  if (!s3Client) {
    throw new HexclaveAssertionError("S3 is not configured");
  }

  const bucket = options.private ? S3_PRIVATE_BUCKET : S3_BUCKET;
  if (!bucket) {
    throw new HexclaveAssertionError(options.private ? "S3 private bucket is not configured" : "S3 bucket is not configured");
  }

  const putInput: PutObjectCommandInput = {
    Bucket: bucket,
    Key: options.key,
    Body: options.body,
  };
  if (options.contentType) putInput.ContentType = options.contentType;
  if (options.contentEncoding) putInput.ContentEncoding = options.contentEncoding;
  const command = new PutObjectCommand(putInput);

  await s3Client.send(command);

  return {
    key: options.key,
  };
}

const CONDITIONAL_PUT_CONFLICT_RETRIES = 3;
const CONDITIONAL_PUT_CONFLICT_RETRY_BASE_MS = 100;

export async function uploadBytesIfAbsent(options: {
  key: string,
  body: Uint8Array,
  contentType?: string,
  contentEncoding?: string,
  private?: boolean,
}): Promise<boolean> {
  const { client, bucket } = getS3Target(options.private === true);
  const putInput: PutObjectCommandInput = {
    Bucket: bucket,
    Key: options.key,
    Body: options.body,
    IfNoneMatch: "*",
  };
  if (options.contentType) putInput.ContentType = options.contentType;
  if (options.contentEncoding) putInput.ContentEncoding = options.contentEncoding;
  return await sendConditionalPutWithConflictRetry(async () => {
    await client.send(new PutObjectCommand(putInput));
  });
}

async function sendConditionalPutWithConflictRetry(sendConditionalPut: () => Promise<void>): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await sendConditionalPut();
      return true;
    } catch (error) {
      if (error instanceof S3ServiceException) {
        const statusCode = error.$metadata.httpStatusCode;
        if (statusCode === 412) {
          return false;
        }
        if (statusCode === 409 && attempt < CONDITIONAL_PUT_CONFLICT_RETRIES) {
          await wait(CONDITIONAL_PUT_CONFLICT_RETRY_BASE_MS * (attempt + 1));
          continue;
        }
      }
      throw error;
    }
  }
}

import.meta.vitest?.test("conditional PUT retries 409 conflicts and reserves false for 412", async ({ expect }) => {
  const makeS3Error = (httpStatusCode: number) => new S3ServiceException({
    name: "TestS3Error",
    $fault: "client",
    $metadata: { httpStatusCode },
  });

  let attempts412 = 0;
  await expect(sendConditionalPutWithConflictRetry(async () => {
    attempts412++;
    throw makeS3Error(412);
  })).resolves.toBe(false);
  expect(attempts412).toBe(1);

  const conflictThenExists = [makeS3Error(409), makeS3Error(412)];
  await expect(sendConditionalPutWithConflictRetry(async () => {
    const error = conflictThenExists.shift();
    if (error !== undefined) throw error;
    throw new Error("unexpected extra attempt");
  })).resolves.toBe(false);

  const conflictThenSuccess = [makeS3Error(409)];
  await expect(sendConditionalPutWithConflictRetry(async () => {
    const error = conflictThenSuccess.shift();
    if (error !== undefined) throw error;
  })).resolves.toBe(true);

  let persistentAttempts = 0;
  await expect(sendConditionalPutWithConflictRetry(async () => {
    persistentAttempts++;
    throw makeS3Error(409);
  })).rejects.toBeInstanceOf(S3ServiceException);
  expect(persistentAttempts).toBe(CONDITIONAL_PUT_CONFLICT_RETRIES + 1);

  await expect(sendConditionalPutWithConflictRetry(async () => {
    throw makeS3Error(500);
  })).rejects.toBeInstanceOf(S3ServiceException);
});

function getS3Target(privateBucket: boolean): { client: S3Client, bucket: string } {
  if (!s3Client) {
    throw new HexclaveAssertionError("S3 is not configured");
  }
  const bucket = privateBucket ? S3_PRIVATE_BUCKET : S3_BUCKET;
  if (!bucket) {
    throw new HexclaveAssertionError(privateBucket ? "S3 private bucket is not configured" : "S3 bucket is not configured");
  }
  return { client: s3Client, bucket };
}

type PresignedUploadOptions = {
  key: string,
  expiresInSeconds: number,
  contentType: string,
  contentEncoding?: string,
  createOnly?: boolean,
  private?: boolean,
};

export function createPresignedUploadCommand(options: PresignedUploadOptions, bucket: string): PutObjectCommand {
  const putInput: PutObjectCommandInput = {
    Bucket: bucket,
    Key: options.key,
    ContentType: options.contentType,
  };
  if (options.createOnly === true) putInput.IfNoneMatch = "*";
  if (options.contentEncoding) putInput.ContentEncoding = options.contentEncoding;
  return new PutObjectCommand(putInput);
}

export async function createPresignedUploadUrl(options: PresignedUploadOptions): Promise<string> {
  const { client, bucket } = getS3Target(options.private === true);
  return await getSignedUrl(
    client,
    createPresignedUploadCommand(options, bucket),
    { expiresIn: options.expiresInSeconds },
  );
}

import.meta.vitest?.test("create-only presigned upload URLs sign If-None-Match as a required header", async ({ expect }) => {
  const testClient = new S3Client({
    region: "us-east-1",
    endpoint: "https://s3.example.com",
    forcePathStyle: true,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
  const options = {
    key: "test-key.js",
    contentType: "application/javascript",
    expiresInSeconds: 900,
    createOnly: true,
  };
  const command = createPresignedUploadCommand(options, "test-bucket");
  expect(command.input.IfNoneMatch).toBe("*");
  const url = await getSignedUrl(testClient, command, { expiresIn: options.expiresInSeconds });
  const signedHeaders = new URL(url).searchParams.get("X-Amz-SignedHeaders")?.split(";") ?? [];
  expect(signedHeaders).toContain("if-none-match");
  expect(new URL(url).searchParams.has("If-None-Match")).toBe(false);
});

export async function headBytes(options: { key: string, private?: boolean, signal?: AbortSignal }): Promise<{
  byteLength: number,
  eTag: string,
} | null> {
  const { client, bucket } = getS3Target(options.private === true);
  const signal = options.signal ?? getOptionalRequestAbortSignal();
  try {
    const response = await awaitS3Operation(
      client.send(new HeadObjectCommand({
        Bucket: bucket,
        Key: options.key,
      }), { abortSignal: signal }),
      signal,
    );
    if (response.ContentLength == null) {
      throw new HexclaveAssertionError("S3 headObject response is missing ContentLength");
    }
    if (response.ETag == null) {
      throw new HexclaveAssertionError("S3 headObject response is missing ETag");
    }
    return {
      byteLength: response.ContentLength,
      eTag: response.ETag,
    };
  } catch (error) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function awaitS3Operation<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    // AWS wraps request cancellation in a provider-specific AbortError. Keep
    // the originating reason so request and explicit cleanup callers can
    // distinguish their own cancellation from an unrelated S3 failure. The
    // name guard matters when cancellation races a real provider error: that
    // error and its S3 status metadata must remain intact.
    if (error instanceof Error && error.name === "AbortError") {
      signal?.throwIfAborted();
    }
    throw error;
  }
}

function isAsyncIterableBody(body: unknown): body is AsyncIterable<unknown> {
  return typeof body === "object"
    && body !== null
    && Symbol.asyncIterator in body
    && typeof body[Symbol.asyncIterator] === "function";
}

function hasTransformToByteArray(body: unknown): body is { transformToByteArray: () => Promise<Uint8Array> } {
  return typeof body === "object"
    && body !== null
    && "transformToByteArray" in body
    && typeof body.transformToByteArray === "function";
}

function isDestroyableBody(body: unknown): body is { destroy: () => void } {
  return typeof body === "object" && body !== null && "destroy" in body && typeof body.destroy === "function";
}

function isCancelableBody(body: unknown): body is { cancel: (reason?: unknown) => Promise<unknown> } {
  return typeof body === "object" && body !== null && "cancel" in body && typeof body.cancel === "function";
}

function attachBodyAbortHandler(body: unknown, signal: AbortSignal | undefined): () => void {
  if (signal == null) return () => {};
  const onAbort = () => {
    if (isDestroyableBody(body)) {
      body.destroy();
    } else if (isCancelableBody(body)) {
      ignoreUnhandledRejection(body.cancel(signal.reason));
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return () => signal.removeEventListener("abort", onAbort);
}

async function readBodyToBytes(body: unknown, signal: AbortSignal | undefined): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (body instanceof Uint8Array) return body;

  // Node.js Readable or any AsyncIterable<Uint8Array>
  if (isAsyncIterableBody(body)) {
    const detachAbortHandler = attachBodyAbortHandler(body, signal);
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of body) {
        signal?.throwIfAborted();
        if (!(chunk instanceof Uint8Array)) {
          throw new HexclaveAssertionError("Unexpected S3 body chunk type");
        }
        chunks.push(Buffer.from(chunk));
      }
      // destroy() is allowed to end a Node stream normally, so the iterator
      // can complete after cancellation without throwing on its own.
      signal?.throwIfAborted();
      return new Uint8Array(Buffer.concat(chunks));
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      detachAbortHandler();
    }
  }

  // SDK stream mixins in non-Node runtimes expose a buffering helper rather
  // than an async iterator. Cancel/destroy it immediately on client abort.
  if (hasTransformToByteArray(body)) {
    const detachAbortHandler = attachBodyAbortHandler(body, signal);
    try {
      const result = await body.transformToByteArray();
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally {
      detachAbortHandler();
    }
  }

  throw new HexclaveAssertionError("Unexpected S3 body type");
}

export async function downloadBytes(options: { key: string, private?: boolean, ifMatch?: string, signal?: AbortSignal }): Promise<Uint8Array> {
  const { client, bucket } = getS3Target(options.private === true);
  const signal = options.signal ?? getOptionalRequestAbortSignal();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: options.key,
    IfMatch: options.ifMatch,
  });

  const res = await awaitS3Operation(
    client.send(command, { abortSignal: signal }),
    signal,
  );
  if (!res.Body) {
    throw new HexclaveAssertionError("S3 getObject returned empty body");
  }

  return await readBodyToBytes(res.Body, signal);
}

export async function deleteBytes(options: { key: string, private?: boolean, signal?: AbortSignal }): Promise<void> {
  const { client, bucket } = getS3Target(options.private === true);
  const signal = options.signal ?? getOptionalRequestAbortSignal();
  await awaitS3Operation(
    client.send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: options.key,
    }), { abortSignal: signal }),
    signal,
  );
}

import.meta.vitest?.test("S3 body buffering cancels immediately with the client signal", async ({ expect }) => {
  const controller = new AbortController();
  const cancellation = new Error("client disconnected");
  let rejectRead: ((reason?: unknown) => void) | undefined;
  const body = {
    transformToByteArray: async () => await new Promise<Uint8Array>((_resolve, reject) => {
      rejectRead = reject;
    }),
    cancel: async (reason?: unknown) => {
      rejectRead?.(reason);
    },
  };

  const readPromise = readBodyToBytes(body, controller.signal);
  await Promise.resolve();
  controller.abort(cancellation);

  await expect(readPromise).rejects.toBe(cancellation);
});

import.meta.vitest?.test("S3 operation failures preserve the originating cancellation reason", async ({ expect }) => {
  const controller = new AbortController();
  const cancellation = new Error("client disconnected");
  const sdkAbortError = new Error("AWS SDK abort wrapper");
  sdkAbortError.name = "AbortError";
  controller.abort(cancellation);

  await expect(awaitS3Operation(
    Promise.reject(sdkAbortError),
    controller.signal,
  )).rejects.toBe(cancellation);

  const unrelatedS3Error = new Error("S3 service unavailable");
  await expect(awaitS3Operation(
    Promise.reject(unrelatedS3Error),
    controller.signal,
  )).rejects.toBe(unrelatedS3Error);
});

async function uploadBase64Image({
  input,
  maxBytes = 1_000_000, // 1MB
  folderName,
}: {
  input: string,
  maxBytes?: number,
  folderName: string,
}) {
  if (!s3Client) {
    throw new HexclaveAssertionError("S3 is not configured");
  }

  let buffer: Buffer;
  let format: string;
  try {
    const result = await parseBase64Image(input, { maxBytes });
    buffer = result.buffer;
    format = result.metadata.format;
  } catch (error) {
    if (error instanceof ImageProcessingError) {
      throw new StatusError(StatusError.BadRequest, error.message);
    }
    throw error;
  }

  const key = `${folderName}/${crypto.randomUUID()}.${format}`;

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
  });

  await s3Client.send(command);

  return {
    key,
    url: getS3PublicUrl(key),
  };
}

export function checkImageString(input: string) {
  return {
    isBase64Image: /^data:image\/[a-zA-Z0-9]+;base64,/.test(input),
    isUrl: /^https?:\/\//.test(input),
  };
}

export async function uploadAndGetUrl(
  input: string | null | undefined,
  folderName: 'user-profile-images' | 'team-profile-images' | 'team-member-profile-images' | 'project-logos'
) {
  if (input) {
    const checkResult = checkImageString(input);
    if (checkResult.isBase64Image) {
      const { url } = await uploadBase64Image({ input, folderName });
      return url;
    } else if (checkResult.isUrl) {
      return input;
    } else {
      throw new StatusError(StatusError.BadRequest, "Invalid profile image URL");
    }
  } else if (input === null) {
    return null;
  } else {
    return undefined;
  }
}
