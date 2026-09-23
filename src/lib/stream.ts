export async function* streamText(
  text: string,
  options: { chunkSize?: number; delayMs?: number } = {},
): AsyncGenerator<string> {
  const chunkSize = options.chunkSize ?? 8;
  const delayMs = options.delayMs ?? 18;
  let cursor = 0;

  while (cursor < text.length) {
    const next = text.slice(cursor, cursor + chunkSize);
    cursor += chunkSize;
    yield next;
    if (cursor < text.length) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
  }
}

export function joinStream(previous: string, chunk: string): string {
  return `${previous}${chunk}`;
}
