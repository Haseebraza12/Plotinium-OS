/**
 * Streaming download of the kernel bundle (boot-and-services.md §3.2 stage 1 (g), §5.5): bytes
 * read drive the asset share of the progress bar, and the Worker is created only after the
 * bundle streamed in, so it is an HTTP- or SW-cache hit.
 */
export async function streamAsset(
  url: string,
  onBytes: (bytes: number, total: number | null) => void,
): Promise<number> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok || res.body === null) throw new Error(`HTTP ${String(res.status)} for ${url}`);
  const header = Number(res.headers.get('content-length') ?? '');
  // Content-Length counts encoded bytes; it is only a hint for the label, never the total.
  const hint = Number.isFinite(header) && header > 0 ? header : null;
  const reader = res.body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
    onBytes(bytes, hint);
  }
}
