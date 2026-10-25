// Bound real streamed bytes, not just Content-Length or decoded characters.
// Used before JSON.parse so oversized requests cannot be fully buffered.
export class BodyTooLarge extends Error {
  constructor() {
    super("request too large");
    this.name = "BodyTooLarge";
  }
}

export async function readLimitedText(request, maxBytes) {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    try { await request.body?.cancel(); } catch { /* Best effort. */ }
    throw new BodyTooLarge();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        try { await reader.cancel(); } catch { /* Preserve the 413 result. */ }
        throw new BodyTooLarge();
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}
