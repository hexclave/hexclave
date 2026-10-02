import { createReleaseLookupRoute, createReleaseUpsertRoute } from "@/lib/releases/release-route-handlers";

export const GET = createReleaseLookupRoute();
export const POST = createReleaseUpsertRoute();
