export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isSellPost(_text: string): boolean {
  return false;
}

export function matchesKeyword(text: string, keywords: string[]): boolean {
  const normalizedText = normalizeText(text);

  return keywords.some((keyword) =>
    normalizedText.includes(normalizeText(keyword)),
  );
}
