import fs from "fs";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { deepPlainEquals, filterUndefined } from "@hexclave/shared/dist/utils/objects";
import { deindent } from "@hexclave/shared/dist/utils/strings";

export type EndpointOutput = {
  status: number,
  responseJson: any,
};

export type OutputData = Map<string, EndpointOutput[]>;

export type ExpectStatusCode = <T = any>(
  expectedStatusCode: number,
  endpoint: string,
  request: RequestInit,
) => Promise<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEndpointOutput(value: unknown): value is EndpointOutput {
  return isRecord(value) && typeof value.status === "number" && "responseJson" in value;
}

/**
 * Reads an output file that may be in either format:
 * - Legacy: a single JSON object keyed by endpoint. This was old
 * - JSONL: one JSON object per line, each `{ endpoint, output }`
 */
export function loadOutputData(filePath: string): OutputData {
  const content = fs.readFileSync(filePath, "utf8").trim();
  const data: OutputData = new Map();
  if (!content) return data;

  const lines = content.split(/\r?\n/);
  const firstLine = lines[0];
  try {
    const parsed = JSON.parse(firstLine);
    if (typeof parsed === "object" && parsed !== null && "endpoint" in parsed && "output" in parsed) {
      for (const line of lines) {
        if (!line.trim()) continue;
        const { endpoint, output } = JSON.parse(line);
        if (!data.has(endpoint)) data.set(endpoint, []);
        data.get(endpoint)!.push(output);
      }
      return data;
    }
  } catch {
    // Not JSONL — fall through to legacy parse
  }

  const legacy = JSON.parse(content);
  if (!isRecord(legacy) || !Object.values(legacy).every((outputs) => Array.isArray(outputs) && outputs.every(isEndpointOutput))) {
    throw new HexclaveAssertionError("Legacy integrity output has an invalid shape");
  }
  for (const [endpoint, outputs] of Object.entries(legacy)) {
    data.set(endpoint, outputs);
  }
  return data;
}

export function createApiHelpers(options: {
  targetOutputData?: OutputData,
  /**
   * When set, each API response is streamed to this file as JSONL
   * (one `{ endpoint, output }` object per line). This avoids
   * accumulating all responses in memory. Writes go to a temporary
   * file first; call `finalizeOutput()` to rename it to the final path.
   */
  outputFilePath?: string,
}) {
  const { targetOutputData, outputFilePath } = options;
  const outputCountByEndpoint = new Map<string, number>();
  const tmpFilePath = outputFilePath ? `${outputFilePath}.tmp` : undefined;

  if (tmpFilePath) {
    fs.writeFileSync(tmpFilePath, "");
  }

  function appendOutputData(endpoint: string, output: EndpointOutput) {
    const count = (outputCountByEndpoint.get(endpoint) ?? 0) + 1;
    outputCountByEndpoint.set(endpoint, count);

    if (targetOutputData) {
      const targetEndpointOutputs = targetOutputData.get(endpoint);
      if (!targetEndpointOutputs) {
        throw new HexclaveAssertionError(deindent`
          Output data mismatch for endpoint ${endpoint}:
            Expected ${endpoint} to be in targetOutputData, but it is not.
        `, { endpoint });
      }
      if (targetEndpointOutputs.length < count) {
        throw new HexclaveAssertionError(deindent`
          Output data mismatch for endpoint ${endpoint}:
            Expected ${targetEndpointOutputs.length} outputs but got at least ${count}.
        `, { endpoint });
      }
      if (!(deepPlainEquals(targetEndpointOutputs[count - 1], output))) {
        throw new HexclaveAssertionError(deindent`
          Output data mismatch for endpoint ${endpoint}:
            Expected output[${JSON.stringify(endpoint)}][${count - 1}] to be:
              ${JSON.stringify(targetEndpointOutputs[count - 1], null, 2)}
            but got:
              ${JSON.stringify(output, null, 2)}.
        `, { endpoint });
      }
    }

    if (tmpFilePath) {
      fs.appendFileSync(tmpFilePath, JSON.stringify({ endpoint, output }) + "\n");
    }
  }

  function verifyOutputCompleteness() {
    if (!targetOutputData) return;
    for (const [endpoint, expectedOutputs] of targetOutputData) {
      const actualCount = outputCountByEndpoint.get(endpoint) ?? 0;
      if (actualCount !== expectedOutputs.length) {
        throw new HexclaveAssertionError(deindent`
          Output data mismatch for endpoint ${endpoint}:
            Expected ${expectedOutputs.length} outputs but got ${actualCount}.
        `, { endpoint, expectedCount: expectedOutputs.length, actualCount });
      }
    }
  }

  function finalizeOutput() {
    if (tmpFilePath && outputFilePath) {
      fs.renameSync(tmpFilePath, outputFilePath);
    }
  }

  const expectStatusCode: ExpectStatusCode = async (expectedStatusCode, endpoint, request) => {
    const apiUrl = new URL(getEnvVariable("NEXT_PUBLIC_STACK_API_URL"));
    const response = await fetch(new URL(endpoint, apiUrl), {
      ...request,
      headers: {
        "x-stack-disable-artificial-development-delay": "yes",
        "x-stack-development-disable-extended-logging": "yes",
        ...filterUndefined(request.headers ?? {}),
      },
    });

    const responseText = await response.text();

    if (response.status !== expectedStatusCode) {
      throw new HexclaveAssertionError(deindent`
        Expected status code ${expectedStatusCode} but got ${response.status} for ${endpoint}:

            ${responseText}
      `, { request, response });
    }

    const responseJson = JSON.parse(responseText);
    const currentOutput: EndpointOutput = {
      status: response.status,
      responseJson,
    };

    appendOutputData(endpoint, currentOutput);

    return responseJson;
  };

  return {
    appendOutputData,
    expectStatusCode,
    verifyOutputCompleteness,
    finalizeOutput,
  };
}
