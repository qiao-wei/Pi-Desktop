/**
 * Reading plain text out of a pi message.
 *
 * Split out of `chatBubbles` so the tool-result half (`chatToolBlocks`) can use
 * the exact same rule without importing the bubble module back — two different
 * "text of a content array" implementations would drift, and a tool result whose
 * text was read differently in the transcript path than in the merge path shows
 * up as a row that changes content on reload.
 */

/** Text blocks joined, images labelled, everything else dropped. */
export function messageToText(message: { content?: unknown }): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      const typed = block as { type?: string; text?: string };
      if (typed.type === "text") return typed.text ?? "";
      if (typed.type === "image") return "[image]";
      return "";
    })
    .join("")
    .trim();
}