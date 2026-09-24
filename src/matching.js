// Free-text answer matching: normalise, then cluster answers that are within a
// small edit distance of each other ("peperoni" ~ "pepperoni", "pancake" ~ "pancakes").

const LEADING_ARTICLE = /^(a|an|the)\s+/;

/** Lowercase, strip accents/punctuation/leading articles, collapse whitespace. */
export function normalizeAnswer(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents: "café" -> "cafe"
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim()
    .replace(LEADING_ARTICLE, '');
}

/**
 * How many character edits still count as "the same answer".
 * Short words get less slack so "cat" and "car" don't merge.
 */
export function allowedDistance(a, b) {
  const len = Math.min(a.length, b.length);
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  return 2;
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
export function editDistance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

export function isSameAnswer(a, b) {
  const max = allowedDistance(a, b);
  return editDistance(a, b, max) <= max;
}

/**
 * Group free-text answers.
 * @param {Array<{ playerId: string, text: string }>} answers
 * @returns {Array<{ label: string, playerIds: string[] }>} largest group first
 */
export function groupFreeText(answers) {
  // 1. Bucket identical normalised answers, remembering how people spelled them.
  const buckets = new Map(); // normalised -> { playerIds, spellings: Map<display, count> }
  for (const { playerId, text } of answers) {
    const key = normalizeAnswer(text);
    if (!key) continue;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { key, playerIds: [], spellings: new Map() };
      buckets.set(key, bucket);
    }
    bucket.playerIds.push(playerId);
    const display = text.trim().replace(/\s+/g, ' ');
    bucket.spellings.set(display, (bucket.spellings.get(display) ?? 0) + 1);
  }

  // 2. Most popular spellings become cluster anchors; near-misses join the first anchor they match.
  //    Comparing only against anchors (not every member) stops chains like a~b~c~d drifting apart.
  const sorted = [...buckets.values()].sort(
    (x, y) => y.playerIds.length - x.playerIds.length || x.key.localeCompare(y.key),
  );
  const clusters = [];
  for (const bucket of sorted) {
    const home = clusters.find((c) => isSameAnswer(c.anchor, bucket.key));
    if (home) {
      home.buckets.push(bucket);
    } else {
      clusters.push({ anchor: bucket.key, buckets: [bucket] });
    }
  }

  // 3. Label each cluster with how people typed its most popular form (the anchor),
  //    preferring a capitalised spelling when counts tie ("Pancakes" over "pancakes").
  const capitalised = (s) => (s[0] !== s[0].toLowerCase() ? 0 : 1);
  return clusters
    .map((c) => {
      const [label] = [...c.buckets[0].spellings.entries()].sort(
        (x, y) => y[1] - x[1] || capitalised(x[0]) - capitalised(y[0]) || x[0].localeCompare(y[0]),
      )[0];
      return { label: prettyLabel(label), playerIds: c.buckets.flatMap((b) => b.playerIds) };
    })
    .sort((x, y) => y.playerIds.length - x.playerIds.length || x.label.localeCompare(y.label));
}

function prettyLabel(text) {
  // Capitalise the first letter only when the whole thing was typed in lowercase.
  return text === text.toLowerCase() ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
