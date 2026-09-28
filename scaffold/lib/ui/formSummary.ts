/**
 * Pure helper behind the collapsed intake-form summary bar (shown after a
 * real search starts): reduces a possibly multi-line, multi-paragraph
 * company description down to one displayable line. No React, no DOM.
 */

/** Collapse `text` to a single line and truncate it to `maxLen` characters
 *  (default 140), appending a single ellipsis character when truncated.
 *  Interior whitespace/newlines collapse to single spaces; leading/trailing
 *  whitespace is trimmed first. Truncation never splits mid-whitespace. */
export function summarizeDescription(text: string, maxLen = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen).trimEnd()}…`;
}
