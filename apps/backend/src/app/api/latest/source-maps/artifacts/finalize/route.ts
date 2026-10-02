import { ArtifactPublicationService } from "@/lib/artifacts/artifact-publication-service";
import { createArtifactFinalizeRoute } from "@/lib/artifacts/artifact-route-handlers";

export const POST = createArtifactFinalizeRoute(ArtifactPublicationService.production());
