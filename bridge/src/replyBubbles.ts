const LONG_SINGLE_BUBBLE_THRESHOLD = 72;
const TARGET_BUBBLE_CHARS = 110;
const MAX_BUBBLES = 5;

function clean(text: string): string {
  return text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function sentenceUnits(text: string): string[] {
  const parts = text
    .split(/(?<=[。！？!?；;])\s*|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) return parts;

  if (text.length > TARGET_BUBBLE_CHARS) {
    const clauses = text
      .split(/(?<=[，,、：:])\s*/u)
      .map((part) => part.trim())
      .filter(Boolean);
    if (clauses.length > 1) return clauses;
  }
  return parts;
}

function hardSplit(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > chunkSize) {
    const window = rest.slice(0, chunkSize + 1);
    const breakAt = Math.max(
      window.lastIndexOf("，"),
      window.lastIndexOf(","),
      window.lastIndexOf("、"),
      window.lastIndexOf(" "),
    );
    const cut = breakAt >= Math.floor(chunkSize * 0.55) ? breakAt + 1 : chunkSize;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function splitLongSingleBubble(text: string): string[] {
  const units = sentenceUnits(text);
  const desired = Math.min(
    MAX_BUBBLES,
    Math.max(2, Math.ceil(text.length / TARGET_BUBBLE_CHARS)),
  );
  const target = Math.ceil(text.length / desired);
  const expanded = units.flatMap((unit) =>
    unit.length > target * 1.7 ? hardSplit(unit, target) : [unit],
  );

  const bubbles: string[] = [];
  let current = "";
  for (let index = 0; index < expanded.length; index += 1) {
    const unit = expanded[index]!;
    const remainingUnits = expanded.length - index;
    const remainingSlots = desired - bubbles.length;
    const wouldOverflow = Boolean(current) && current.length + unit.length > target;
    const shouldBreak = wouldOverflow && remainingSlots > 1 && remainingUnits >= remainingSlots;

    if (shouldBreak) {
      bubbles.push(current.trim());
      current = unit;
    } else {
      current += unit;
    }
  }
  if (current.trim()) bubbles.push(current.trim());

  if (bubbles.length === 1 && text.length > LONG_SINGLE_BUBBLE_THRESHOLD) {
    return hardSplit(text, Math.ceil(text.length / 2)).slice(0, MAX_BUBBLES);
  }
  return bubbles.slice(0, MAX_BUBBLES);
}

export function normalizeReplyBubbles(messages: string[]): string[] {
  const cleaned = messages.map(clean).filter(Boolean);
  if (cleaned.length !== 1) return cleaned.slice(0, MAX_BUBBLES);
  const [only] = cleaned;
  if (!only || only.length <= LONG_SINGLE_BUBBLE_THRESHOLD) return only ? [only] : [];
  return splitLongSingleBubble(only);
}
