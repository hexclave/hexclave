import { createReleaseArtifactListRoute, createReleaseArtifactRegistrationRoute } from "@/lib/releases/release-route-handlers";

export const GET = createReleaseArtifactListRoute();
export const POST = createReleaseArtifactRegistrationRoute();
