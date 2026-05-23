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

export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    // Split camelCase / PascalCase boundaries BEFORE lowercasing.
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // Split sequences of capitals: "URLPath" → "URL Path".
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}
