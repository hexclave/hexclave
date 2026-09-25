import { GcpApiError, GcpClient, parseGcpOperation } from "./client.js";

export class ArtifactRegistryClient {
  constructor(
    private readonly client: GcpClient,
    private readonly projectId: string,
    private readonly region: string,
    private readonly repository = "marshal",
  ) {}

  get registryHost(): string {
    return `${this.region}-docker.pkg.dev`;
  }

  imageRepository(serviceName: string): string {
    return `${this.registryHost}/${this.projectId}/${this.repository}/${serviceName}`;
  }

  async ensureRepository(): Promise<void> {
    const name = `projects/${this.projectId}/locations/${this.region}/repositories/${this.repository}`;
    const url = `https://artifactregistry.googleapis.com/v1/${name}`;
    if (await this.client.request(url, { allow404: true }) !== null) return;
    let operation: unknown;
    try {
      operation = await this.client.request(`https://artifactregistry.googleapis.com/v1/projects/${this.projectId}/locations/${this.region}/repositories?repositoryId=${encodeURIComponent(this.repository)}`, {
        method: "POST",
        body: {
          name,
          format: "DOCKER",
          description: "Tenant container images built by Hexclave Marshal",
          labels: { "hexclave-managed": "true" },
          dockerConfig: { immutableTags: false },
        },
      });
    } catch (error) {
      // One repository serves every service in the tenant project and this runs on every
      // deployment, so two concurrent first deploys both read 404 above and both POST here.
      // Artifact Registry answers the loser with ALREADY_EXISTS, which IS the state this
      // function exists to reach — failing that deployment on it would be inventing a conflict
      // out of a converged outcome.
      if (!(error instanceof GcpApiError && error.status === 409)) throw error;
      return;
    }
    await this.client.waitForOperation(parseGcpOperation(operation), { apiBaseUrl: "https://artifactregistry.googleapis.com/v1/", timeoutMillis: 10 * 60 * 1000 });
  }
}
