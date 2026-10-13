import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

export async function GET(request: Request) {
  return await toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request) {
  return await toNextJsHandler(getAuth()).POST(request);
}
