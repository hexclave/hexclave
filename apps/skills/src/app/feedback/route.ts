import { handleFeedbackOptions, handleFeedbackRoute } from "@/feedback-route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return await handleFeedbackRoute(req);
}

export async function POST(req: Request) {
  return await handleFeedbackRoute(req);
}

export async function HEAD(req: Request) {
  return await handleFeedbackRoute(req);
}

export function OPTIONS() {
  return handleFeedbackOptions();
}
