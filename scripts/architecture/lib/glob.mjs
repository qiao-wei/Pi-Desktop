/**
 * 最小 glob：`**` 跨目录（含**零段**），`*` 只在本段内匹配。
 *
 * 「`**` 要能匹配零段」是踩过的坑：第一版把前导 `**` 短接成 true，结果所有路由都"已实现"、
 * 规则等于没有（`tests/processBoundaries.test.ts` 钉着这条）。
 */

/** Minimal glob: `**` spans directories (including zero segments), `*` stays inside a segment. */
export function matchGlob(pattern, file) {
  return matchSegments(pattern.split("/"), file.split("/"));
}

/** One segment against one path segment: `*` matches inside the segment only. */
export function globSegmentMatches(patternSegment, pathSegment) {
  if (!patternSegment.includes("*")) return patternSegment === pathSegment;
  const escaped = patternSegment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`).test(pathSegment);
}

/**
 * Proper segment matching. A `**` segment consumes any number of segments, so a suffix pattern
 * only matches paths that end that way. Before this, a leading `**` short-circuited to `true`,
 * which made every route look implemented and silently emptied the `protocol-surface` rule.
 */
export function matchSegments(patternSegments, pathSegments) {
  if (patternSegments.length === 0) return pathSegments.length === 0;
  const [head, ...rest] = patternSegments;
  if (head === "**") {
    for (let index = 0; index <= pathSegments.length; index += 1) {
      if (matchSegments(rest, pathSegments.slice(index))) return true;
    }
    return false;
  }
  if (pathSegments.length === 0) return false;
  if (head !== ":param" && !globSegmentMatches(head, pathSegments[0])) return false;
  return matchSegments(rest, pathSegments.slice(1));
}
