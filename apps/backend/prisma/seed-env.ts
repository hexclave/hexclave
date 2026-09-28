export function resolveInternalProjectKeyAlias(
  canonicalName: string,
  aliasName: string,
  canonicalValue: string,
  aliasValue: string,
): string {
  if (canonicalValue !== "" && aliasValue !== "" && canonicalValue !== aliasValue) {
    throw new Error(`Environment variables ${canonicalName} and ${aliasName} are both set to different non-empty values. Remove one of them or set them to the same value.`);
  }
  return canonicalValue || aliasValue;
}
