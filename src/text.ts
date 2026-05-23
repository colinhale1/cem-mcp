// Shared text tokenization for the BM25 text index. The tokenizer is tuned
// for component-library text, which mixes natural language ("Shows a toast
// notification") with code-shaped identifiers (`onValueChange`, `<sl-input>`,
// `color-scheme`). We split camelCase boundaries before lowercasing so
// PascalCase / camelCase identifiers contribute their semantic pieces, and we
// split on any non-alphanumeric so kebab tags and HTML brackets dissolve into
// their constituent words.

// A tight UI-domain stopword list. Notably absent: "input", "button", "list",
// "menu" — those are meaningful in this domain.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by", "can",
  "could", "did", "do", "does", "for", "from", "had", "has", "have", "he", "her",
  "here", "his", "how", "i", "if", "in", "into", "is", "it", "its", "may", "me",
  "might", "must", "my", "no", "not", "of", "on", "or", "our", "out", "over",
  "shall", "she", "should", "so", "some", "such", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "through", "to",
  "too", "up", "us", "use", "very", "was", "we", "were", "what", "when", "where",
  "which", "who", "why", "will", "with", "would", "you", "your",
  // UI-vague verbs that appear in many descriptions and add no signal:
  "show", "shows", "display", "displays", "render", "renders", "provide",
  "provides", "allow", "allows", "enable", "enables", "represent", "represents",
  "specify", "specifies", "set", "sets", "get", "gets", "make", "makes",
]);

// Light suffix-stripping stemmer. Not a full Porter — we just want word-form
// collapse so "loading" and "load", "expandable" and "expand", "buttons" and
// "button" share an indexed form. The rules are intentionally conservative
// (5+ char tokens only) to avoid butchering short legitimate words like
// "this", "was", "us", "tab".
//
// Applied at BOTH index time and query time, so the produced stem doesn't
// need to be a real English word — it just needs to be stable.
export function stem(token: string): string {
  if (token.length < 5) return token;

  // -able / -ible: expandable → expand, collapsible → collaps
  if (token.length >= 6 && (token.endsWith("able") || token.endsWith("ible"))) {
    return token.slice(0, -4);
  }
  // -ing: loading → load (length guard excludes "thing", "string").
  if (token.length >= 6 && token.endsWith("ing")) return token.slice(0, -3);
  // -ed: loaded → load. Length guard avoids butchering short -ed words.
  if (token.length >= 6 && token.endsWith("ed")) return token.slice(0, -2);
  // -ly: quickly → quick.
  if (token.length >= 5 && token.endsWith("ly")) return token.slice(0, -2);
  // Plural -s: buttons → button. Skip -ss / -us / 5-letter words to avoid
  // false positives like alias → alia, focus → focu, class → clas.
  if (
    token.length >= 6 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    // Split camelCase / PascalCase boundaries BEFORE lowercasing.
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Split sequences of capitals: "URLPath" → "URL Path".
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}
