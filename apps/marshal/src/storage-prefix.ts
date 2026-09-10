// A separate object namespace lets disposable live tests exercise the real store
// without sharing specs, signing keys, queues, or leases with a running Marshal.
export function storagePrefix(): string {
  const prefix = process.env.HEXCLAVE_MARSHAL_S3_KEY_PREFIX ?? "";
  if (prefix !== "" && !/^(?:[a-zA-Z0-9_-]+\/)+$/.test(prefix)) {
    throw new Error("HEXCLAVE_MARSHAL_S3_KEY_PREFIX must be empty or slash-separated alphanumeric segments ending in '/'");
  }
  return prefix;
}

export function storageKey(logicalKey: string): string {
  return storagePrefix() + logicalKey;
}

export function logicalStorageKey(physicalKey: string): string {
  const prefix = storagePrefix();
  if (!physicalKey.startsWith(prefix)) throw new Error("object storage returned a key outside the configured prefix");
  return physicalKey.slice(prefix.length);
}
