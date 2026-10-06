import { createServerError } from "../../server-error";

export const runtime = "nodejs";

export async function POST(): Promise<never> {
  throw createServerError();
}
