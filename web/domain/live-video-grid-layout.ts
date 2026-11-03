/**
 * Sizes the live meeting participant grid. The column count is whichever
 * gives the largest fixed-aspect tiles for the stage, so narrow stages stack
 * and wide, short stages line tiles up in a row.
 */

const TWO_PARTICIPANT_COUNT = 2;
const THREE_PARTICIPANT_COUNT = 3;
const TWO_COLUMN_COUNT = 2;
const SINGLE_COLUMN_COUNT = 1;
const SIDE_BY_SIDE_MIN_TILE_WIDTH_RATIO = 0.72;
const WASTED_GRID_SLOT_PENALTY = 0.5;
const INITIAL_BEST_SCORE = -1;

type LiveVideoGridLayout = {
  columns: number;
  tileWidth: number;
  tileHeight: number;
  /**
   * Three people in two columns leave one tile alone on the second row; it
   * is centered under the first row instead of sitting flush left.
   */
  isLastTileCentered: boolean;
};

export function getLiveVideoGridLayout({
  count,
  width,
  height,
  gap,
  aspectRatio,
}: {
  count: number;
  width: number;
  height: number;
  gap: number;
  aspectRatio: number;
}): LiveVideoGridLayout | null {
  if (count <= 0 || width <= 0 || height <= 0) {
    return null;
  }

  const getCandidateTileWidth = (candidateColumns: number) => {
    const candidateRows = Math.ceil(count / candidateColumns);
    const availableWidth = Math.max(0, width - gap * (candidateColumns - 1));
    const availableHeight = Math.max(0, height - gap * (candidateRows - 1));
    const tileWidthByColumns = availableWidth / candidateColumns;
    const tileWidthByHeight = (availableHeight * aspectRatio) / candidateRows;

    return Math.max(0, Math.min(tileWidthByColumns, tileWidthByHeight));
  };

  const toLayout = (input: { columns: number; tileWidth: number }): LiveVideoGridLayout => ({
    columns: input.columns,
    tileWidth: input.tileWidth,
    tileHeight: input.tileWidth / aspectRatio,
    isLastTileCentered: count === THREE_PARTICIPANT_COUNT && input.columns === TWO_COLUMN_COUNT,
  });

  if (count === TWO_PARTICIPANT_COUNT) {
    const stackedTileWidth = getCandidateTileWidth(SINGLE_COLUMN_COUNT);
    const sideBySideTileWidth = getCandidateTileWidth(TWO_COLUMN_COUNT);

    if (sideBySideTileWidth >= stackedTileWidth * SIDE_BY_SIDE_MIN_TILE_WIDTH_RATIO) {
      return toLayout({ columns: TWO_COLUMN_COUNT, tileWidth: sideBySideTileWidth });
    }
  }

  const columnCandidates = Array.from({ length: count }, (_, index) => index + SINGLE_COLUMN_COUNT);
  const bestCandidate = columnCandidates.reduce<{
    columns: number;
    score: number;
    tileWidth: number;
  }>(
    (best, candidateColumns) => {
      const candidateRows = Math.ceil(count / candidateColumns);
      const candidateTileWidth = getCandidateTileWidth(candidateColumns);
      const candidateTileHeight = candidateTileWidth / aspectRatio;
      const candidateTileArea = candidateTileWidth * candidateTileHeight;
      const candidateCapacity = candidateColumns * candidateRows;
      const wastedSlots = candidateCapacity - count;
      const score = candidateTileArea - wastedSlots * WASTED_GRID_SLOT_PENALTY;
      const isBetterScore = score > best.score;
      const isTieWithLargerTile = score === best.score && candidateTileWidth > best.tileWidth;

      if (isBetterScore || isTieWithLargerTile) {
        return { columns: candidateColumns, score, tileWidth: candidateTileWidth };
      }

      return best;
    },
    { columns: SINGLE_COLUMN_COUNT, score: INITIAL_BEST_SCORE, tileWidth: 0 },
  );

  return toLayout({ columns: bestCandidate.columns, tileWidth: bestCandidate.tileWidth });
}
