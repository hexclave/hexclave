import { ArtifactUploadService } from "@/lib/artifacts/artifact-upload-service";
import { createArtifactRegistrationRoute } from "@/lib/artifacts/artifact-route-handlers";

export const POST = createArtifactRegistrationRoute(ArtifactUploadService.production());
