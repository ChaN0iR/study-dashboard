export class BodyTooLarge extends Error {}

// Count bytes while reading, including chunked requests with no Content-Length.
export async function readLimitedText(request, maxBytes) {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    await request.body?.cancel();
    throw new BodyTooLarge();
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new BodyTooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
