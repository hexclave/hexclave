import { getEnvVariable } from "@hexclave/shared/dist/utils/env";

const ansiCodes = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

type AnsiColor = Exclude<keyof typeof ansiCodes, "reset">;

/**
 * The dev request log is piped through Turborepo, so stdout is never a TTY here and an
 * `isTTY` check would disable colors for everyone. Colors are therefore on by default and
 * only the NO_COLOR convention (https://no-color.org) turns them off.
 */
function colorsEnabled() {
  return getEnvVariable("NO_COLOR", "") === "";
}

function paint(text: string, ...colors: AnsiColor[]) {
  if (!colorsEnabled()) {
    return text;
  }
  return colors.map((color) => ansiCodes[color]).join("") + text + ansiCodes.reset;
}

function methodColor(method: string): AnsiColor {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD": {
      return "blue";
    }
    case "POST": {
      return "green";
    }
    case "PUT":
    case "PATCH": {
      return "yellow";
    }
    case "DELETE": {
      return "red";
    }
    default: {
      return "magenta";
    }
  }
}

function statusColor(status: number | string | undefined): AnsiColor {
  const statusNumber = typeof status === "number" ? status : Number(status);
  if (!Number.isFinite(statusNumber)) {
    return "gray";
  }
  if (statusNumber >= 500) return "red";
  if (statusNumber >= 400) return "yellow";
  if (statusNumber >= 300) return "cyan";
  if (statusNumber >= 200) return "green";
  return "gray";
}

function durationColor(elapsedMilliseconds: number | null): AnsiColor {
  // Thresholds are eyeballed for local development: most endpoints answer in tens of
  // milliseconds, so anything past 300ms is worth noticing and past 1s is worth fixing.
  if (elapsedMilliseconds == null) return "gray";
  if (elapsedMilliseconds >= 1000) return "red";
  if (elapsedMilliseconds >= 300) return "yellow";
  return "gray";
}

/**
 * Formats the per-request line printed in development. Colors encode the three things you
 * scan for when watching the log: what was called, whether it succeeded, and how slow it was.
 */
export function formatDevelopmentRequestLog(input: {
  method: string,
  pathname: string,
  status: number | string | undefined,
  elapsedMilliseconds: number | null,
}): string {
  const status = input.status ?? "???";
  const duration = input.elapsedMilliseconds == null ? "unknown" : `${input.elapsedMilliseconds.toFixed(1)}ms`;
  return [
    paint("[Elysia]", "dim"),
    paint(input.method, methodColor(input.method), "bold"),
    paint(input.pathname, "gray"),
    paint(`${status}`, statusColor(input.status), "bold"),
    paint(duration, durationColor(input.elapsedMilliseconds)),
  ].join(" ");
}

import.meta.vitest?.test("development request logs are color-coded by method, status and duration", ({ expect }) => {
  const { vi } = import.meta.vitest!;
  vi.stubEnv("NO_COLOR", "");
  try {
    // Escape codes are rendered as `\e[...` so the snapshot stays readable in source.
    expect([
      formatDevelopmentRequestLog({ method: "GET", pathname: "/api/v1/users", status: 200, elapsedMilliseconds: 12.34 }),
      formatDevelopmentRequestLog({ method: "POST", pathname: "/api/v1/users", status: 500, elapsedMilliseconds: 1234.5 }),
      formatDevelopmentRequestLog({ method: "BREW", pathname: "/api/v1/teapot", status: undefined, elapsedMilliseconds: null }),
    ].join("\n").replaceAll("\x1b", "\\e")).toMatchInlineSnapshot(`
      "\\e[2m[Elysia]\\e[0m \\e[34m\\e[1mGET\\e[0m \\e[90m/api/v1/users\\e[0m \\e[32m\\e[1m200\\e[0m \\e[90m12.3ms\\e[0m
      \\e[2m[Elysia]\\e[0m \\e[32m\\e[1mPOST\\e[0m \\e[90m/api/v1/users\\e[0m \\e[31m\\e[1m500\\e[0m \\e[31m1234.5ms\\e[0m
      \\e[2m[Elysia]\\e[0m \\e[35m\\e[1mBREW\\e[0m \\e[90m/api/v1/teapot\\e[0m \\e[90m\\e[1m???\\e[0m \\e[90munknown\\e[0m"
    `);
  } finally {
    vi.unstubAllEnvs();
  }
});

import.meta.vitest?.test("NO_COLOR disables the escape codes", ({ expect }) => {
  const { vi } = import.meta.vitest!;
  vi.stubEnv("NO_COLOR", "1");
  try {
    expect(formatDevelopmentRequestLog({
      method: "GET",
      pathname: "/api/v1/users",
      status: 404,
      elapsedMilliseconds: 5,
    })).toMatchInlineSnapshot(`"[Elysia] GET /api/v1/users 404 5.0ms"`);
  } finally {
    vi.unstubAllEnvs();
  }
});
