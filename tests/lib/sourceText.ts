/**
 * Reading `server/index.mjs` from a test.
 *
 * The bridge is a script, not a module: importing it would start a server, so tests assert on
 * its source instead. These extractors keep those assertions honest - bodies are sliced by
 * balanced braces and limited to one function/object, so a match elsewhere in the file (or in a
 * comment) cannot satisfy an assertion by accident.
 */

export function functionBody(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`source 里找不到 function ${name}(`);
  let index = start + marker.length;
  let parenDepth = 1;
  while (index < source.length && parenDepth > 0) {
    if (source[index] === "(") parenDepth += 1;
    else if (source[index] === ")") parenDepth -= 1;
    index += 1;
  }
  if (parenDepth !== 0) throw new Error(`function ${name} 的参数表没闭合`);
  while (index < source.length && source[index] !== "{") index += 1;
  if (index >= source.length) throw new Error(`function ${name} 没有函数体`);
  return balancedBraces(source, index, `function ${name}`);
}

/** Also handles `export function` / `async function`, since the marker is the bare name. */
export function constObjectBody(source: string, name: string): string {
  const marker = `const ${name} = {`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`source 里找不到 const ${name}`);
  return balancedBraces(source, start + marker.length - 1, `const ${name}`);
}

function balancedBraces(source: string, openBraceIndex: number, label: string): string {
  let depth = 0;
  let index = openBraceIndex;
  while (index < source.length) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBraceIndex, index + 1);
    }
    index += 1;
  }
  throw new Error(`${label} 的花括号没配平`);
}