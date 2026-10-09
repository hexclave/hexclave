import { declareBreezyDatabaseWithStorage, type BreezyPiledriverDatabaseOptions } from "../breezy/core.js";
import { openBreezyLMDBStorage } from "./storage.js";

export type { BreezyPiledriverDatabaseOptions } from "../breezy/core.js";
export type BreezyLMDBOptions = { path: string, dbId?: string, compression?: boolean };

export function declareBreezyLMDBPiledriverDatabase(
  lmdbOptions: BreezyLMDBOptions,
  options: BreezyPiledriverDatabaseOptions = {},
) {
  return declareBreezyDatabaseWithStorage(openBreezyLMDBStorage(lmdbOptions), lmdbOptions.dbId, options);
}
