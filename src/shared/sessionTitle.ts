/**
 * The submit-time provisional session title.
 *
 * When a prompt is submitted the sidebar has to show *something* immediately,
 * long before the model answers and long before any summary title exists. Both
 * sides of the wire have to derive that placeholder with the same rule: the
 * client paints it optimistically, and the server keeps reporting the same
 * string while the first turn runs - otherwise the first snapshot overwrites the
 * optimistic row with a different title.
 *
 * Pure module: no DOM, no node builtins, safe to import from server and web.
 */
import { parseAttachmentContext } from "./chatBubbles.ts";

/**
 * Title budget, counted in units: one per CJK character, one per Latin/number
 * word (not per letter). Spaces and punctuation are free.
 */
export const sessionTitleMaxChars = 12;
/**
 * When a title runs past the budget the cut chases forward to the nearest
 * punctuation so the title reads as a complete clause - but never past this many
 * units, otherwise one far-away punctuation could stretch the title indefinitely.
 */
export const sessionTitleMaxChaseChars = 22;

/**
 * English cap for the *summary* title prompt (server side). The submit-time
 * title above counts Latin words as one unit each, so it needs no separate
 * word budget; this constant only feeds the model prompt.
 */
export const sessionTitleMaxWords = 5;

export interface SessionTitleInput {
  /** Raw or display text of the first user message. Attachment context, if
   *  present, is parsed away before anything else. */
  text?: string | null;
  /** Explicit attachment names, used when the text yields nothing. */
  attachments?: readonly { name?: string | null }[] | null;
  maxChars?: number;
}

const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/u;
const HIDDEN_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/gu;
const FENCED_CODE_RE = /```[^\n]*\n([\s\S]*?)```/gu;
const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/gu;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/gu;
const BARE_URL_RE = /<?\b(?:https?:\/\/|www\.)([^\s<>()]+)>?/giu;
const INLINE_CODE_RE = /`+([^`\n]*)`+/gu;
const HTML_TAG_RE = /<\/?[a-zA-Z][^>\n]{0,200}>/gu;
const BADGE_ATTR_RE = /\bdata-[a-z-]+="[^"]*"/giu;
const SIZE_TOKEN_RE = /(?:\d+(?:\.\d+)?)\s?(?:KiB|MiB|GiB|TiB|KB|MB|GB|TB|B)\b/gu;
const LINE_MARKER_RE = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+)/gmu;
const EMPHASIS_RE = /[*~]+/gu;
const SENTENCE_DOT_RE = /(\D)\.(?=\s|$)/gu;
const SENTENCE_SPLIT_RE = /[。！？；!?;\n]+/u;
const CLAUSE_SPLIT_RE = /[，,、]+/u;
const TRAILING_PUNCT_RE = /[。！？；：、，,.!?;:~…\-—\s]+$/u;
const DANGLING_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|哦|以及|然后|还有|这个|那个)+$/u;
const LEADING_QUANTIFIER_RE = /^(?:这个|那个|这段|那段|一份|一个|一件|这件|那件)[ \t]*/u;
const ROLE_CLAUSE_RE = /^(?:你(?:现在)?(?:是|是一名?)|请你?作为|作为一名|作为一个|as an?|you are|act as)/iu;
const THROWAWAY_RE = /^(?:你好|您好|哈喽|嗨|在吗|在么|在不在|hi|hello|hey|thanks|thank you|thx|ok|okay|好的|好|嗯|哦|[?？!！.。]+)$/iu;
/** A leading clause that only sets up time/condition for the real request. */
const SETUP_TAIL_RE = /(?:后|之后|以后|之前|以前|的时候|的话|然后|所以|但是|不过|如果|假如)$/u;
const LATIN_FILLER_RE = /([A-Za-z])一下/gu;

/** Context-setting prefixes, longest first so "你是" cannot eat "你是一位". */
const CONTEXT_PREFIXES = ["请你作为", "你现在是", "你是一位", "你是一个", "作为一名", "作为一个", "背景是", "上下文是", "你是", "作为", "context:", "background:"];

/** Polite / instruction openers that carry no topic. Longest first. */
const INSTRUCTION_LEADS = [
  "请帮我", "请帮忙", "请给我", "帮我看看", "帮我看一下", "帮我看下", "帮我", "帮忙", "麻烦你", "麻烦", "劳烦", "拜托",
  "请问一下", "请问", "我想", "我要", "我需要", "需要", "能否", "能不能", "可不可以", "可以", "请你", "给我", "请", "帮",
  "优化一下", "优化下", "优化", "改进一下", "改进下", "改进", "调整一下", "调整下", "调整",
  "完善一下", "完善下", "完善", "修复一下", "修复下", "修复", "补充一下", "补充下", "补充",
  "更新一下", "更新下", "更新", "实现一下", "实现下", "实现", "总结一下", "总结下", "总结",
  "分析一下", "分析下", "分析", "解释一下", "解释下", "解释", "说明一下", "说明",
  "改一下", "改下", "改成", "改", "参考一下", "参考",
  "看看", "看下", "看一下",
];

const LATIN_LEADS = [
  "i would like", "i'd like", "help me", "can you", "could you", "would you", "please",
  "how do i", "how can i", "how to", "what is", "what's", "tell me",
];

const LATIN_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "without", "to", "of", "in", "on", "at", "by", "from",
  "is", "are", "was", "were", "be", "been", "do", "does", "did", "doing",
  "how", "what", "why", "when", "where", "which", "who", "whom",
  "i", "me", "my", "we", "our", "us", "you", "your", "it", "its", "this", "that", "these", "those",
  "please", "can", "could", "would", "should", "let", "about", "into", "over", "after", "before",
  "attached", "file", "files",
]);

function sortLongestFirst(values: readonly string[]): string[] {
  return [...values].sort((left, right) => right.length - left.length);
}

const CONTEXT_PREFIXES_SORTED = sortLongestFirst(CONTEXT_PREFIXES);
const LEADING_NOISE_RE = new RegExp(`^(?:${sortLongestFirst(INSTRUCTION_LEADS).join("|")})[ \\t]*`, "u");
const LATIN_LEAD_RE = new RegExp(`^(?:${sortLongestFirst(LATIN_LEADS).join("|")})\\b[ \\t,]*`, "iu");

/** Turn a raw first message into a clean, single-line title candidate set. */
function cleanTitleSource(input: string): string {
  let text = String(input ?? "")
    .normalize("NFC")
    .replace(/\r\n?/gu, "\n")
    .replace(HIDDEN_CHAR_RE, "");

  // Code fences carry no topic; keep the body only in case the whole message is
  // one code block, so the title is not empty.
  const fenced: string[] = [];
  text = text.replace(FENCED_CODE_RE, (_match, body: string) => {
    fenced.push(String(body));
    return " \n";
  });

  text = text
    .replace(IMAGE_RE, "$1 ")
    .replace(LINK_RE, "$1 ")
    .replace(INLINE_CODE_RE, "$1")
    .replace(BARE_URL_RE, (_match, rest: string) => {
      const host = String(rest).split(/[/?#]/u)[0].replace(/^www\./iu, "");
      return host ? ` ${host} ` : " ";
    })
    .replace(HTML_TAG_RE, " ")
    .replace(/<\/?pi_desktop_[a-z_]*>/giu, " ")
    .replace(BADGE_ATTR_RE, " ")
    .replace(SIZE_TOKEN_RE, " ")
    .replace(LINE_MARKER_RE, "")
    .replace(EMPHASIS_RE, "")
    .replace(LATIN_FILLER_RE, "$1")
    .replace(SENTENCE_DOT_RE, "$1\n");

  if (!hasContent(text) && fenced.length) {
    text = fenced.join("\n");
  }

  return text
    .replace(/[^\S\n]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{2,}/gu, "\n")
    .trim();
}

function stripInstructionLead(input: string): string {
  let text = String(input ?? "").trim();
  const lowered = text.toLowerCase();
  for (const prefix of CONTEXT_PREFIXES_SORTED) {
    if (lowered.startsWith(prefix.toLowerCase())) {
      text = text.slice(prefix.length).trim();
      break;
    }
  }
  for (let index = 0; index < 4; index += 1) {
    const next = text.replace(LEADING_NOISE_RE, "").replace(LATIN_LEAD_RE, "").trim();
    if (next === text) {
      break;
    }
    text = next;
  }
  return text.replace(LEADING_QUANTIFIER_RE, "").trim();
}

function firstMeaningfulClause(text: string): string {
  const segments = text.split(SENTENCE_SPLIT_RE).map((segment) => segment.trim()).filter(Boolean);

  let fallback = "";
  for (const segment of segments) {
    const candidate = pickClause(segment);
    if (!candidate || !hasContent(candidate)) {
      continue;
    }
    if (!fallback) {
      fallback = candidate;
    }
    if (THROWAWAY_RE.test(candidate)) {
      continue;
    }
    return candidate;
  }
  return fallback;
}

/**
 * Strip the opener from one sentence, then decide which comma clause carries
 * the topic. Role setups ("你是资深工程师"), greetings and leading time clauses
 * ("升级后，") are dropped when a real request follows them.
 */
function pickClause(segment: string): string {
  const cleaned = stripInstructionLead(segment);
  if (!cleaned) {
    return "";
  }

  const rawClauses = segment.split(CLAUSE_SPLIT_RE).map((clause) => clause.trim()).filter(Boolean);
  let clauses = cleaned.split(CLAUSE_SPLIT_RE).map((clause) => stripInstructionLead(clause.trim())).filter(Boolean);
  let dropped = 0;
  while (clauses.length > 1) {
    const first = clauses[0];
    const rawFirst = rawClauses[dropped] ?? first;
    if (ROLE_CLAUSE_RE.test(rawFirst) || THROWAWAY_RE.test(first) || SETUP_TAIL_RE.test(first)) {
      dropped += 1;
      clauses = clauses.slice(1);
      continue;
    }
    break;
  }
  return clauses.length ? clauses.join("，") : cleaned;
}

function trimTrailingPunctuation(input: string): string {
  return String(input ?? "").trim().replace(TRAILING_PUNCT_RE, "").trim();
}

function stripTrailingNoise(input: string): string {
  let text = trimTrailingPunctuation(input);
  const withoutDangling = text.replace(DANGLING_TAIL_RE, "").trim();
  if (hasContent(withoutDangling)) {
    text = withoutDangling;
  }
  return text;
}

/**
 * A truncation can leave an English fragment hanging ("报错：TypeError: x is").
 * Drop trailing stopwords / one-letter leftovers until the title ends on
 * something whole.
 */
function trimDanglingLatinTail(input: string): string {
  let text = input;
  for (let index = 0; index < 3; index += 1) {
    const match = /[ \t]*[A-Za-z0-9'’\-_.]+$/u.exec(text);
    if (!match) {
      break;
    }
    const word = match[0].trim();
    if (word.length > 1 && !LATIN_STOPWORDS.has(word.toLowerCase())) {
      break;
    }
    text = stripTrailingNoise(text.slice(0, text.length - match[0].length));
  }
  return text;
}

/** Punctuation that makes a cut read as a complete clause; a comma counts. */
const TITLE_BOUNDARY_PUNCT_RE = /[，,、；;：:。！？!?]/u;

/**
 * A `.` only ends a sentence when it is not glued inside a token: `index.mjs`
 * and `Node.js` keep their dot, `done. Next` ends one.
 */
function isTitleBoundaryPunct(chars: readonly string[], index: number): boolean {
  const char = chars[index] ?? "";
  if (TITLE_BOUNDARY_PUNCT_RE.test(char)) {
    return true;
  }
  if (char === ".") {
    const prev = chars[index - 1] ?? "";
    const next = chars[index + 1] ?? "";
    return !/[A-Za-z0-9]/u.test(prev) || !/[A-Za-z0-9]/u.test(next);
  }
  return false;
}

interface TitleToken {
  start: number;
  end: number;
  /** CJK character = 1, Latin/number word = 1, anything else = 0. */
  units: number;
  punct: boolean;
}

/**
 * Split a title into budget units. A Latin token (word / path / identifier) is one
 * unit no matter how many letters it has; every CJK character is its own unit.
 */
function tokenizeTitle(chars: readonly string[]): TitleToken[] {
  const tokens: TitleToken[] = [];
  let index = 0;
  while (index < chars.length) {
    const char = chars[index];
    if (CJK_CHAR_RE.test(char)) {
      tokens.push({ start: index, end: index + 1, units: 1, punct: false });
      index += 1;
      continue;
    }
    if (/[A-Za-z0-9]/u.test(char)) {
      let end = index + 1;
      while (end < chars.length && /[A-Za-z0-9'’._/\\-]/u.test(chars[end])) {
        end += 1;
      }
      tokens.push({ start: index, end, units: 1, punct: false });
      index = end;
      continue;
    }
    tokens.push({ start: index, end: index + 1, units: 0, punct: isTitleBoundaryPunct(chars, index) });
    index += 1;
  }
  return tokens;
}

/** How many budget units a title costs (CJK chars + Latin words). */
export function sessionTitleUnits(text: string): number {
  const chars = [...String(text ?? "")];
  return tokenizeTitle(chars).reduce((sum, token) => sum + token.units, 0);
}

function truncateSessionTitle(text: string, maxUnits: number): string {
  const chars = [...text];
  const tokens = tokenizeTitle(chars);
  const total = tokens.reduce((sum, token) => sum + token.units, 0);
  if (total <= maxUnits) {
    return text;
  }

  const chaseMax = maxUnits + (sessionTitleMaxChaseChars - sessionTitleMaxChars);

  // Walk to the end of the unit that reaches the budget. A Latin word is a single
  // unit, so the boundary never lands inside a word.
  let units = 0;
  let boundary = chars.length;
  let index = 0;
  for (; index < tokens.length; index += 1) {
    units += tokens[index].units;
    if (units >= maxUnits) {
      boundary = tokens[index].end;
      index += 1;
      break;
    }
  }

  // Past the budget, prefer to end on the nearest punctuation (comma included) so
  // the title is a complete clause instead of a chopped-off fragment. The chase is
  // capped so a far-away punctuation cannot stretch the title without bound.
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    units += token.units;
    if (units > chaseMax) {
      break;
    }
    if (token.punct) {
      return chars.slice(0, token.end).join("").trim();
    }
  }

  return chars.slice(0, boundary).join("").trim();
}

function truncatePlain(text: string, maxChars: number): string {
  return [...text].slice(0, maxChars).join("").trim();
}

function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export function deriveSessionTitle(input: SessionTitleInput | string | null | undefined): string {
  const source: SessionTitleInput = typeof input === "string" || input == null ? { text: input } : input;
  const parsed = parseAttachmentContext(String(source.text ?? ""));
  const attachments = source.attachments?.length ? source.attachments : parsed.attachments;
  const maxChars = source.maxChars ?? sessionTitleMaxChars;

  const clause = firstMeaningfulClause(cleanTitleSource(parsed.text));
  if (clause) {
    const fitted = trimTrailingPunctuation(clause);
    // Within budget the title is kept whole. Trimming trailing particles here is
    // what turned "Jev 不是开源的吗" into the half phrase "Jev 不是开源".
    if (fitted && sessionTitleUnits(fitted) <= maxChars) {
      return fitted;
    }
    const truncated = truncateSessionTitle(fitted || clause, maxChars);
    // Dangling clean-up only makes sense for something that was actually cut.
    const refined = trimDanglingLatinTail(truncated);
    const title = stripTrailingNoise(refined);
    if (title) {
      return title;
    }
  }

  const fileName = (attachments ?? [])
    .map((attachment) => String(attachment?.name ?? "").trim())
    .find((name) => Boolean(name));
  if (fileName) {
    const safeName = stripTrailingNoise(fileName);
    if (safeName) {
      // A file name is an identifier: cut on token boundaries, never mid-word.
      return truncateSessionTitle(safeName, maxChars);
    }
  }
  return "";
}