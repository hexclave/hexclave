// Shared UTF-8 byte-length measurement for backend libs.
//
// Implemented with Buffer.byteLength instead of `new TextEncoder().encode(...).byteLength`
// to match the Buffer.byteLength(s, "utf8") convention used across the
// codebase. For well-formed strings the two agree; for lone surrogates both
// count 3 bytes (Buffer encodes the raw code point, TextEncoder a U+FFFD
// replacement), so lengths — but not bytes — are identical in that edge case
// too. Do NOT use this where the encoded *bytes* themselves matter and
// untrusted lone surrogates are possible; use TextEncoder there for the
// standard replacement-char behavior. Note: Buffer is Node-only, so this
// helper must not be used inside workflow sandbox source code
// (src/lib/workflows/**), which runs on runtimes without Buffer.
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
