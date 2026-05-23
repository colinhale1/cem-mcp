// "Did you mean?" suggestion for unknown package names. Package names like
// `@esri/calcite-components` don't fit the kebab-tag indexer (mixed
// separators, scoped prefix), so we use a small dedicated matcher: substring
// containment + capped Levenshtein on the normalized form.

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = new Array<number>(bl + 1);
  let curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[bl]!;
}

// Strip the @scope/ prefix so a query like "calcit-components" (which doesn't
// include the "esri" scope) can still match @esri/calcite-components against
// the unscoped basename.
function basename(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

function bestScore(query: string, target: string, cap: number): number {
  if (target === query) return 1000;
  // Strong: target contains the full query (target is at least as specific).
  if (target.includes(query)) {
    return 500 + Math.max(0, 100 - Math.abs(target.length - query.length));
  }
  // Weaker: query contains the target — only meaningful when the target is
  // most of the query, otherwise it's incidental (e.g. "components" appearing
  // inside "calcitcomponents" shouldn't outscore the obvious typo match).
  if (query.includes(target) && target.length >= query.length * 0.7) {
    return 400 + Math.max(0, 80 - Math.abs(target.length - query.length));
  }
  const d = editDistance(query, target, cap);
  if (d <= cap) return 300 - 20 * d;
  return 0;
}

export function suggestPackages(
  query: string,
  available: ReadonlyArray<string>,
  limit = 3,
): string[] {
  const q = normalize(query);
  if (!q || available.length === 0) return [];

  // Allow up to ~30% of the query length in edits, capped to make the math
  // interesting only for non-trivially-close strings.
  const cap = Math.max(2, Math.floor(q.length * 0.3));

  const scored: Array<{ name: string; score: number }> = [];
  for (const name of available) {
    // Score against both the full normalized form and the unscoped basename;
    // keep the better of the two so typos in the unscoped name still match.
    const full = normalize(name);
    const base = normalize(basename(name));
    const score = Math.max(bestScore(q, full, cap), bestScore(q, base, cap));
    if (score > 0) scored.push({ name, score });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return scored.slice(0, limit).map((s) => s.name);
}
