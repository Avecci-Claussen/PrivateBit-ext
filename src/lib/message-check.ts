/** Checks on a message a website asks to sign. */
/** Characters that change how text looks without being visible: bidi controls, zero width, other controls. */
const HIDDEN_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]/g;

/**
 * Warnings for a message a site asks to sign (audit F-04): hidden or direction changing
 * characters that make the text read differently than it is, and text that is only a hash, which
 * could be a signature for something else entirely.
 */
export function messageRisks(text: string): string[] {
  const out: string[] = [];
  if ((text.match(HIDDEN_RE) ?? []).length) out.push("This message has hidden characters that can make it read differently than what is signed. They are shown as [U+code] below.");
  if (/^\s*(0x)?[0-9a-f]{64}\s*$/i.test(text)) out.push("This message is only a 64 character hash. You cannot tell what it stands for. Sign it only if you know exactly why the site needs it.");
  if (/^\s*(70736274ff|cHNidP8)/i.test(text)) out.push("This message looks like a transaction, not text. Sign transactions only through a transaction review.");
  return out;
}

/** The message with hidden characters made visible, for the review. */
export function visibleMessage(text: string): string {
  return text.replace(HIDDEN_RE, (c) => (c === "\t" ? c : `[U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`));
}
