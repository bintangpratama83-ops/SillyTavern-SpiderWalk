/**
 * Helper-model prompts. The helper only maps the story into knots and strands;
 * it never writes story text.
 */

export const HELPER_SYSTEM = `You map a roleplay story into a web of connected things for a memory tool.
Return ONLY one JSON object, no other text:
{"knots":[{"name":"","kind":"","aliases":[],"note":""}],"strands":[{"a":"","b":"","why":"","strength":2}]}

KNOTS are things that matter to the story: person, place, thing, secret, promise, plan, event, relationship, trait.
- name: short and stable (a person's usual name; a thing like "The photos"). Reuse an EXISTING name exactly when it is the same thing.
- aliases: other names or nicknames actually used (max 4).
- note: one plain sentence about what matters about it NOW (who knows it, what is at stake, what changed).
STRANDS join two knots that really affect each other.
- why: a short plain reason ("she hides the sessions from him", "the key opens the cellar").
- strength: 1 weak, 2 clear, 3 central to the story.

Rules: only what the card, lorebook titles or chat actually establish; never invent events, feelings or secrets. Don't describe the user's inner thoughts. Skip trivia (furniture, weather) unless the story keeps returning to it. Plain words, no lists inside notes.`;

/**
 * @param {object} p
 * @param {string} p.card           character card text (may be empty after the first build)
 * @param {string[]} p.loreTitles   lorebook entry titles
 * @param {{name:string, kind:string}[]} p.existing  knots already in the web
 * @param {string} p.chat           recent chat, oldest first, "Name: text" lines
 * @param {number} p.maxKnots
 * @param {number} p.maxStrands
 */
export function helperUserPrompt({ card = '', loreTitles = [], existing = [], chat = '', maxKnots = 12, maxStrands = 16 }) {
    const parts = [];
    if (card) parts.push(`CHARACTER CARD:\n${card}`);
    if (loreTitles.length) parts.push(`LOREBOOK ENTRY TITLES (already their own knots; use these names in strands when relevant):\n${loreTitles.join('; ')}`);
    if (existing.length) parts.push(`EXISTING KNOTS (reuse these names exactly):\n${existing.map(k => `${k.name} [${k.kind}]`).join('; ')}`);
    if (chat) parts.push(`RECENT CHAT (oldest first):\n${chat}`);
    parts.push(`TASK: Add or update at most ${maxKnots} knots and ${maxStrands} strands that the text above establishes. Prefer what changed recently and what links people to secrets, promises and plans. Return only the JSON object.`);
    return parts.join('\n\n');
}
