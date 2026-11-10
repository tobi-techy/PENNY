/**
 * iMessage shows raw text, so markdown from the model would reach the thread as
 * asterisks and backticks. Replies go through here first: bold/italics and code
 * marks dropped, list markers removed, [label](url) becomes "label (url)".
 */
export function toPlainText(md: string): string {
  return md
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?]|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Drop decorative emoji and tidy the spacing. Penny keeps emoji only when the
 * user sent one first (see HOUSE_RULES), so replies are cleaned deterministically.
 */
export function stripEmoji(text: string): string {
  return text
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function hasEmoji(text: string): boolean {
  return /\p{Extended_Pictographic}/u.test(text);
}
