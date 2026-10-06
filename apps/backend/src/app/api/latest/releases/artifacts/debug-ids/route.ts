import {
  createDebugIdAssociationRoute,
  createDebugIdLookupRoute,
} from "@/lib/releases/release-route-handlers";

export const GET = createDebugIdLookupRoute();
export const POST = createDebugIdAssociationRoute();
