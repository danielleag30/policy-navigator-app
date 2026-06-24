/**
 * SHA-256 content hash for PendingIngestion deduplication.
 * Exported as contentHash(input) -> lowercase hex string.
 * Task 0-10 dependency — imported by ingest-orchestrator.
 *
 * Uses the Web Crypto API available in every Deno / Edge Function runtime.
 */
export async function contentHash(
  input: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  const data =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof ArrayBuffer
      ? new Uint8Array(input)
      : input;
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
