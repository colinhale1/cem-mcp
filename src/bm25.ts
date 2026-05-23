// Okapi BM25 over a per-component token corpus.
//
// Each component is treated as one "document" containing every searchable
// piece of text (description, summary, attribute names and descriptions, slot
// descriptions, event names and descriptions, CSS var / part names and
// descriptions, and the tag itself). At query time we tokenize the user's
// query the same way and score each component:
//
//   score(doc, query) = Σ_term IDF(term) · (tf · (k1+1)) / (tf + k1 · (1 - b + b · |doc|/avgdl))
//
// where IDF(term) = ln(1 + (N - df + 0.5) / (df + 0.5)).
//
// Parameters use the standard tuned defaults (k1=1.5, b=0.75). The index is
// built once at load time and held in memory; per-query lookup is just a few
// hash-map probes per query token, so latency stays well under a millisecond
// even on a several-hundred-component package.

const K1 = 1.5;
const B = 0.75;

interface PostingsEntry {
  /** Document frequency: how many docs contain this term. */
  df: number;
  /** Map<docId, term frequency within that doc>. */
  postings: Map<string, number>;
}

export interface Bm25Index {
  totalDocs: number;
  avgDocLength: number;
  terms: Map<string, PostingsEntry>;
  docLengths: Map<string, number>;
}

export function buildBm25Index(docs: Map<string, string[]>): Bm25Index {
  const terms = new Map<string, PostingsEntry>();
  const docLengths = new Map<string, number>();
  let totalLength = 0;

  for (const [docId, tokens] of docs) {
    docLengths.set(docId, tokens.length);
    totalLength += tokens.length;

    // Count term frequencies in this doc once, then fold into the global index.
    const tfs = new Map<string, number>();
    for (const t of tokens) tfs.set(t, (tfs.get(t) ?? 0) + 1);

    for (const [t, tf] of tfs) {
      let entry = terms.get(t);
      if (!entry) {
        entry = { df: 0, postings: new Map() };
        terms.set(t, entry);
      }
      entry.df++;
      entry.postings.set(docId, tf);
    }
  }

  return {
    totalDocs: docs.size,
    avgDocLength: docs.size > 0 ? totalLength / docs.size : 0,
    terms,
    docLengths,
  };
}

export interface WeightedTerm {
  term: string;
  weight: number;
}

export function scoreBm25(index: Bm25Index, queryTerms: WeightedTerm[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (index.totalDocs === 0) return scores;
  const avgdl = Math.max(index.avgDocLength, 1);

  for (const { term, weight } of queryTerms) {
    const entry = index.terms.get(term);
    if (!entry) continue;
    const idf = Math.log(1 + (index.totalDocs - entry.df + 0.5) / (entry.df + 0.5));
    if (idf <= 0) continue;

    for (const [docId, tf] of entry.postings) {
      const dl = index.docLengths.get(docId) ?? 0;
      const denom = tf + K1 * (1 - B + B * (dl / avgdl));
      const contrib = idf * ((tf * (K1 + 1)) / denom) * weight;
      scores.set(docId, (scores.get(docId) ?? 0) + contrib);
    }
  }

  return scores;
}
