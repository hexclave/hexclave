import { releaseService, type ReleaseService } from "../releases/release-service";
import type { ArtifactScope } from "./artifact-manifest";
import {
  ArtifactUploadService,
  type ArtifactManifestFinalizeResult,
  type FinalizedManifest,
} from "./artifact-upload-service";

export type ArtifactPublicationFinalizeResult = ArtifactManifestFinalizeResult & {
  catalogStatus: "published" | "already_published" | "unversioned",
};

type ArtifactFinalizationStore = Pick<ArtifactUploadService, "finalizeManifest" | "readFinalizedManifest">;
type ReleaseCatalogProjection = Pick<ReleaseService, "publishFinalizedManifest">;

export class ArtifactPublicationService {
  public constructor(
    private readonly artifacts: ArtifactFinalizationStore,
    private readonly releases: ReleaseCatalogProjection,
  ) {}

  public static production(): ArtifactPublicationService {
    return new ArtifactPublicationService(ArtifactUploadService.production(), releaseService);
  }

  public async finalizeManifest(
    scope: ArtifactScope,
    request: { manifestSha256: string },
  ): Promise<ArtifactPublicationFinalizeResult> {
    const storageResult = await this.artifacts.finalizeManifest(scope, request);
    const manifest = await this.artifacts.readFinalizedManifest(scope, storageResult.manifestSha256);
    if (manifest.release === null) {
      return { ...storageResult, catalogStatus: "unversioned" };
    }
    const releasedManifest: FinalizedManifest & { release: string } = {
      ...manifest,
      release: manifest.release,
    };
    const catalogStatus = await this.releases.publishFinalizedManifest({
      tenancy: {
        id: scope.tenantId,
        project: { id: scope.projectId },
        branchId: scope.branchId,
      },
    }, releasedManifest);
    return { ...storageResult, catalogStatus };
  }
}
