import { ArtifactUploadService } from "@/lib/artifacts/artifact-upload-service";
import { createArtifactLookupRoute } from "@/lib/artifacts/artifact-route-handlers";

export const GET = createArtifactLookupRoute(ArtifactUploadService.production());
