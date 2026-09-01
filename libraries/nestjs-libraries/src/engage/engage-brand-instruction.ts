// Brand-mention control shared by every Engage generation prompt (reply
// drafts, reference-post generation). Extracted from engage-draft.service.ts
// — none of this logic is reply-specific ("Do not mention any brand name",
// "Proactively introduce X and invite the person to try it" apply just as
// well to an original post), unlike the per-strategy prompt text, which stays
// separate per caller because it IS framed around replying vs. writing an
// original post. See docs/engage/reference-post-generation.md §6.
//
// `noun` (default 'reply', preserving engage-draft.service.ts's exact
// original wording byte-for-byte) lets a caller writing something that isn't
// a reply — e.g. reference-post generation passing 'post' — get output that
// doesn't say "the reply must contain X" about text that isn't a reply.

// brandStrength 3 (the maximum) is the only tier where naming the brand is a
// contract rather than a suggestion: the caller explicitly asked for a
// promotional generation, so an output without the brand name is not what
// was ordered. Tiers 0-2 stay advisory (the model may legitimately decide
// the brand doesn't fit).
export const MANDATORY_BRAND_STRENGTH = 3;

export function requiresMention(
  brandStrength: number,
  mentions?: string[]
): string[] {
  if (brandStrength < MANDATORY_BRAND_STRENGTH) return [];
  return (mentions ?? []).map((m) => m.trim()).filter(Boolean);
}

// Case-insensitive, whitespace-tolerant containment. Substring matching is
// deliberate: "@AISEE", "AISEE's" and "(AISEE)" all count as naming the brand.
function normalizeForMentionMatch(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ');
}

export function containsRequiredMention(
  text: string,
  mentions: string[]
): boolean {
  const haystack = normalizeForMentionMatch(text);
  return mentions.some((mention) =>
    haystack.includes(normalizeForMentionMatch(mention).trim())
  );
}

function buildMentionRequirement(mentions: string[], noun: string): string {
  const list = mentions.map((m) => `"${m}"`).join(', ');
  const requirement =
    mentions.length === 1
      ? `the ${noun} MUST contain ${list}, spelled exactly as written, at least once`
      : `the ${noun} MUST contain at least one of these names, spelled exactly as written: ${list}`;
  return `This is a hard requirement — ${requirement}. A ${noun} that omits it is invalid.`;
}

export function buildBrandInstruction(
  brandStrength: number,
  mentions?: string[],
  noun: string = 'reply'
): string {
  const brand = mentions?.length ? mentions.join(', ') : null;
  switch (brandStrength) {
    case 0:
      return 'Do not mention any brand name. Provide pure value.';
    case 1:
      return "Share insights and data naturally; you don't need to name any brand to be genuinely useful.";
    case 2:
      return brand
        ? `When highly relevant, naturally mention ${brand} as an example or tool.`
        : "Share insights naturally; you don't need to name any brand to be genuinely useful.";
    case 3:
      return brand
        ? `Proactively introduce ${brand} and invite the person to try it. ${buildMentionRequirement(
            requiresMention(brandStrength, mentions),
            noun
          )}`
        : "Share insights naturally; you don't need to name any brand to be genuinely useful.";
    default:
      return "Share insights and data naturally; you don't need to name any brand to be genuinely useful.";
  }
}

// Appended to the system prompt when the brand name is mandatory. Per-strategy
// prompts (a one-sentence cap, "only a question", etc.) and any "relevance
// takes priority" rule each give the model a reason to drop the name — this
// block resolves those conflicts in the brand's favour without licensing
// invented claims about it.
export function buildMandatoryBrandBlock(
  mentions: string[],
  noun: string = 'reply'
): string {
  const list = mentions.map((m) => `"${m}"`).join(' / ');
  return `Brand requirement (non-negotiable):
- ${list} must appear verbatim in the ${noun}. Never swap it for "this tool", "a tool I use", an abbreviation, or a paraphrase.
- If the strategy above caps you at one sentence or a tight word count, add at most one short extra clause or sentence so the name fits naturally — the length limit below still applies.
- Stay honest: name it as what you'd genuinely point this person to. Do not invent features, pricing, results, or numbers for it.
- The relevance rules still govern what you say, but they are never a reason to leave the name out.`;
}
