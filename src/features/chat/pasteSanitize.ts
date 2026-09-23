/**
 * Paste sanitization for the composer.
 *
 * Copied rich text (web pages, docs, spreadsheets) carries tables, inline
 * styles, fonts, colors and scripts. The composer keeps only:
 *   - text
 *   - simple text styles (b/strong, i/em, u, code)
 *   - line breaks — tables are flattened to lines (cells joined with spaces,
 *     one row per line), block boundaries become line breaks.
 *   - inline badges (attachments / skills), when the caller asks for them:
 *     the badge is emitted as a positional placeholder and its identity is
 *     collected so the editor can rebuild the real node.
 */
import {
  PASTE_BADGE_ATTRIBUTE,
  readBadgeDescriptor,
  type ClipboardBadge,
} from "./badgeClipboard.ts";

/** Structural DOM shape so the walk runs against a real DOM or a test fixture. */
export interface SanitizeNode {
  nodeName?: string | null;
  textContent?: string | null;
  childNodes?: ArrayLike<SanitizeNode>;
  dataset?: Record<string, string | undefined> | null;
}

/** Options controlling how much of the copied markup survives. */
export interface SanitizeOptions {
  /**
   * When present, badge elements become `data-tender-paste-badge` placeholders
   * and their descriptors are appended here, in document order.
   */
  badges?: ClipboardBadge[];
}

const TEXT_NODE_NAME = "#TEXT";
const BR = "BR";
const TD_TH = new Set(["TD", "TH"]);
const TR = "TR";
const TABLE = "TABLE";

/** Tags whose entire subtree is dropped (invisible/machine markup). */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "TITLE", "LINK",
  "IFRAME", "OBJECT", "SVG", "CANVAS", "VIDEO", "AUDIO", "SELECT", "TEXTAREA",
  "INPUT", "BUTTON", "MAP",
]);

/** Block-level boundaries become line breaks. */
export const COMPOSER_BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
  "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
  "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "UL",
]);

/** Simple text styles the composer keeps, mapped to their output tag. */
const STYLE_TAGS: Record<string, string> = {
  B: "b",
  STRONG: "b",
  I: "i",
  EM: "i",
  U: "u",
  CODE: "code",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function forEachChild(
  node: SanitizeNode,
  visit: (child: SanitizeNode, index: number, length: number) => void,
) {
  const children = node.childNodes;
  const length = children?.length ?? 0;
  for (let index = 0; index < length; index += 1) {
    visit(children![index], index, length);
  }
}

function nodeNameOf(node: SanitizeNode): string {
  return (node.nodeName ?? "").toUpperCase();
}

/** A cell's text: whitespace collapsed, <br> treated as a space. */
function tableCellText(cell: SanitizeNode): string {
  let text = "";
  const walk = (node: SanitizeNode) => {
    const name = nodeNameOf(node);
    if (name === TEXT_NODE_NAME) {
      text += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (name === BR) {
      text += " ";
      return;
    }
    forEachChild(node, walk);
  };
  walk(cell);
  return text.trim();
}

function tableRowText(row: SanitizeNode): string {
  const cells: string[] = [];
  const walk = (node: SanitizeNode) => {
    const name = nodeNameOf(node);
    if (TD_TH.has(name)) {
      cells.push(tableCellText(node));
      return;
    }
    forEachChild(node, walk);
  };
  walk(row);
  return cells.filter((cell) => cell.length > 0).join("  ");
}

function flattenTable(table: SanitizeNode): string {
  const rows: string[] = [];
  const walk = (node: SanitizeNode) => {
    if (nodeNameOf(node) === TR) {
      rows.push(tableRowText(node));
      return;
    }
    forEachChild(node, walk);
  };
  walk(table);
  return rows.filter((row) => row.length > 0).map(escapeHtml).join("<br>");
}

/**
 * Rich copied HTML → sanitized markup string containing only text nodes,
 * <br>, and <b>/<i>/<u>/<code>. Block boundaries and table rows become <br>.
 */
export function htmlToSanitizedMarkup(root: SanitizeNode, options?: SanitizeOptions): string {
  let out = "";
  const badges = options?.badges;

  const walk = (node: SanitizeNode, isLastSibling: boolean) => {
    const name = nodeNameOf(node);
    if (!name) {
      return;
    }
    if (name === TEXT_NODE_NAME) {
      out += escapeHtml(node.textContent ?? "");
      return;
    }
    if (badges) {
      const badge = readBadgeDescriptor(node);
      if (badge) {
        const index = badges.push(badge) - 1;
        out += `<span ${PASTE_BADGE_ATTRIBUTE}="${index}"></span>`;
        return;
      }
    }
    if (SKIP_TAGS.has(name)) {
      return;
    }
    if (name === BR) {
      out += "<br>";
      return;
    }
    if (name === TABLE) {
      out += flattenTable(node);
      if (!isLastSibling) {
        out += "<br>";
      }
      return;
    }
    const styleTag = STYLE_TAGS[name];
    if (styleTag) {
      out += `<${styleTag}>`;
      forEachChild(node, (child, index, length) => walk(child, index === length - 1));
      out += `</${styleTag}>`;
      return;
    }
    if (COMPOSER_BLOCK_TAGS.has(name)) {
      forEachChild(node, (child, index, length) => walk(child, index === length - 1));
      out += "<br>";
      return;
    }
    forEachChild(node, (child, index, length) => walk(child, index === length - 1));
  };

  forEachChild(root, (child, index, length) => walk(child, index === length - 1));

  return out
    .replace(/^(<br>)+/, "")
    .replace(/(<br>)+$/, "")
    .replace(/(?:<br>){3,}/g, "<br><br>");
}
