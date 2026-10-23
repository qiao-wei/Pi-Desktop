/**
 * 生成区域的读写：`docs/architecture/*.md` 里的 `<!-- architecture:begin X --> … <!-- architecture:end X -->`
 * 由 policy 生成并逐字节校验 —— 这段进出的唯一实现，生成侧与校验侧共用。
 */

export const REGION_OPEN = "<!-- architecture:begin ";
export const REGION_CLOSE = "<!-- architecture:end ";

export function readRegion(text, name) {
  const open = `${REGION_OPEN}${name} -->`;
  const close = `${REGION_CLOSE}${name} -->`;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.indexOf(close, start);
  if (end === -1) return null;
  return text.slice(start + open.length, end);
}

export function writeRegion(text, name, body) {
  const open = `${REGION_OPEN}${name} -->`;
  const close = `${REGION_CLOSE}${name} -->`;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.indexOf(close, start);
  const next = `${open}\n${body.trim()}\n${close}`;
  return text.slice(0, start) + next + text.slice(end + close.length);
}
