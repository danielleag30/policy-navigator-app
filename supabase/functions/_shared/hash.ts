/**
 * Canonical content_hash utility for Policy Navigator.
 *
 * Algorithm: SHA-256 via Web Crypto (`crypto.subtle.digest`).
 * Chosen for collision resistance and universal availability on all Deno/browser
 * runtimes without external dependencies.
 *
 * Output: 64-character lowercase hex string (256 bits / 4 bits per hex digit).
 *
 * This is the ONLY place in the codebase that produces a content_hash value.
 * All document deduplication logic must import `contentHash` from here.
 */

/**
 * Returns the SHA-256 hex digest of `input` (UTF-8 encoded).
 */
export async function contentHash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
