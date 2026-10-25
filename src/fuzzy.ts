interface ScoreRow {
  scores: Float64Array;
  runBonuses: Float64Array;
}

// Scores follow fzf: a run of consecutive letters keeps the bonus of its first letter, and
// opening a gap costs more than extending one, so an exact run beats scattered word starts.
const wordBoundaries = new Set([':', '/', '-', '_', ' ']);
const matchScore = 16;
const boundaryBonus = 8;
const consecutiveBonus = 4;
const firstLetterMultiplier = 2;
const gapStartPenalty = 3;
const gapExtensionPenalty = 1;

const boundaryBonusAt = (letters: string[], index: number): number => {
  const previous = letters[index - 1];

  return previous === undefined || wordBoundaries.has(previous) ? boundaryBonus : 0;
};

const isSubsequence = (term: string[], letters: string[]): boolean => {
  let found = 0;

  for (let index = 0; index < letters.length && found < term.length; index += 1) {
    if (letters[index] === term[found]) {
      found += 1;
    }
  }

  return found === term.length;
};

const firstScoreRow = (letters: string[], letter: string): ScoreRow => {
  const scores = new Float64Array(letters.length).fill(-Infinity);
  const runBonuses = new Float64Array(letters.length);

  for (let index = 0; index < letters.length; index += 1) {
    if (letters[index] === letter) {
      const bonus = boundaryBonusAt(letters, index);

      scores[index] = matchScore + bonus * firstLetterMultiplier;
      runBonuses[index] = bonus;
    }
  }

  return { scores, runBonuses };
};

const nextScoreRow = (previous: ScoreRow, letters: string[], letter: string): ScoreRow => {
  const scores = new Float64Array(letters.length).fill(-Infinity);
  const runBonuses = new Float64Array(letters.length);
  let afterGap = -Infinity;

  for (let index = 0; index < letters.length; index += 1) {
    const beforeGap = previous.scores[index - 2] ?? -Infinity;

    afterGap = Math.max(afterGap - gapExtensionPenalty, beforeGap - gapStartPenalty);

    if (letters[index] === letter) {
      const bonus = boundaryBonusAt(letters, index);
      const adjacent = previous.scores[index - 1] ?? -Infinity;
      const runBonus = Math.max(bonus, previous.runBonuses[index - 1] ?? 0, consecutiveBonus);
      const consecutive = adjacent + matchScore + runBonus;
      const gapped = afterGap + matchScore + bonus;
      const keepsRun = consecutive >= gapped;

      scores[index] = keepsRun ? consecutive : gapped;
      runBonuses[index] = keepsRun ? runBonus : bonus;
    }
  }

  return { scores, runBonuses };
};

const termScore = (term: string[], letters: string[]): number | null => {
  const [first, ...rest] = term;

  if (first === undefined || !isSubsequence(term, letters)) {
    return null;
  }

  let row = firstScoreRow(letters, first);

  for (const letter of rest) {
    row = nextScoreRow(row, letters, letter);
  }

  const best = Math.max(...row.scores);

  return Number.isFinite(best) ? best : null;
};

export const fuzzyScore = (terms: string[][], text: string): number | null => {
  const letters = Array.from(text.toLowerCase());
  let total = 0;

  for (const term of terms) {
    const score = termScore(term, letters);

    if (score === null) {
      return null;
    }

    total += score;
  }

  return total;
};
