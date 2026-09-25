import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";

const PLACEHOLDER = "REPLACE_ME";

function isDev() {
  return process.env.NODE_ENV === "development";
}

function definedEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed == null || trimmed === "" || trimmed === PLACEHOLDER) return undefined;
  return trimmed;
}

export function envOrDevDefault(value: string | undefined, devDefault: string, name: string): string {
  const defined = definedEnvValue(value);
  if (defined == null) {
    if (isDev()) return devDefault;
    throw new HexclaveAssertionError(`${name} is not configured. Set the NEXT_PUBLIC_HEXCLAVE_* vars in .env.local or the hosting platform env.`);
  }
  return defined;
}

export function hexclaveApiUrl(): string {
  const hexclaveValue = definedEnvValue(process.env.NEXT_PUBLIC_HEXCLAVE_API_URL);
  const stackValue = definedEnvValue(process.env.NEXT_PUBLIC_STACK_API_URL);
  if (hexclaveValue != null && stackValue != null && hexclaveValue !== stackValue) {
    throw new HexclaveAssertionError("Environment variables NEXT_PUBLIC_HEXCLAVE_API_URL and NEXT_PUBLIC_STACK_API_URL are both set to different values. Remove one of them or set them to the same value.");
  }
  const devDefault = `http://localhost:${definedEnvValue(process.env.NEXT_PUBLIC_HEXCLAVE_PORT_PREFIX) ?? "81"}02`;
  return envOrDevDefault(hexclaveValue ?? stackValue, devDefault, "NEXT_PUBLIC_HEXCLAVE_API_URL");
}
