/**
 * Token accounting.
 *
 * ~4 chars/token, the same approximation graft itself uses (src/context/savings.ts),
 * so the comparison is on their terms rather than ours. We only ever apply it to
 * text a retriever ACTUALLY emits — never to a hypothetical "you would have read
 * these files whole" baseline, which is the move that makes graft's own savings
 * counter unfalsifiable.
 */
export const toTokens = (chars) => Math.round(String(chars).length / 4);

export const textTokens = (s) => toTokens(String(s ?? ''));
