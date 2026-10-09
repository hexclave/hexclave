import { declareBreezyDatabaseWithStorage, type BreezyPiledriverDatabaseOptions } from "./core.js";
import { openBreezyLmdbStorage } from "./storage-lmdb.js";

export type { BreezyPiledriverDatabaseOptions } from "./core.js";
export type BreezyPiledriverLmdbOptions = { path: string, dbId?: string, compression?: boolean };

export function declareBreezyPiledriverDatabase(
  lmdbOptions: BreezyPiledriverLmdbOptions,
  options: BreezyPiledriverDatabaseOptions = {},
) {
  return declareBreezyDatabaseWithStorage(openBreezyLmdbStorage(lmdbOptions), lmdbOptions.dbId, options);
}
