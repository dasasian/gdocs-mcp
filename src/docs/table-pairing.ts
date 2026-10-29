import { StyleSyntaxError } from './css.js';

/** For each old line the new line it became, and for each new line the old line it came from. A line with `undefined` is deleted (old) or inserted (new). */
export interface Pairing {
  forOld: (number | undefined)[];
  forNew: (number | undefined)[];
}

export type Axis = 'row' | 'column';

type Pair = [oldIndex: number, newIndex: number];

interface Gap {
  old: number[];
  new: number[];
}

export function refusal(message: string): StyleSyntaxError {
  return new StyleSyntaxError([message], new Set([message]));
}

export const keyOf = (line: string[]): string => JSON.stringify(line);

const wordsIn = (line: string[]): string[] => line.filter((word) => word !== '');

function sharedWords(a: string[], b: string[]): number {
  const available = new Map<string, number>();
  for (const word of wordsIn(a)) available.set(word, (available.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of wordsIn(b)) {
    const left = available.get(word) ?? 0;
    if (left > 0) {
      shared++;
      available.set(word, left - 1);
    }
  }
  return shared;
}

const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

function exactAnchors(oldKeys: string[], newKeys: string[]): Pair[] {
  const longest = Array.from({ length: oldKeys.length + 1 }, () => new Array<number>(newKeys.length + 1).fill(0));
  for (let i = oldKeys.length - 1; i >= 0; i--) {
    for (let j = newKeys.length - 1; j >= 0; j--) {
      longest[i][j] = oldKeys[i] === newKeys[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1]);
    }
  }
  const anchors: Pair[] = [];
  let i = 0;
  let j = 0;
  while (i < oldKeys.length && j < newKeys.length) {
    if (oldKeys[i] === newKeys[j]) anchors.push([i++, j++]);
    else if (longest[i + 1][j] >= longest[i][j + 1]) i++;
    else j++;
  }
  return anchors;
}

function gapsAround(pairs: Pair[], oldCount: number, newCount: number): Gap[] {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const edges: Pair[] = [[-1, -1], ...sorted, [oldCount, newCount]];
  return edges.slice(1).map(([oldEdge, newEdge], i) => ({ old: range(edges[i][0] + 1, oldEdge), new: range(edges[i][1] + 1, newEdge) }));
}

function bestAlignment(scores: number[][]): { pairs: Pair[]; unique: boolean } {
  const rows = scores.length;
  const columns = scores[0].length;
  const best = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  const ways = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(1));
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= columns; j++) {
      const skipOld = best[i - 1][j];
      const skipNew = best[i][j - 1];
      const paired = scores[i - 1][j - 1] > 0 ? best[i - 1][j - 1] + scores[i - 1][j - 1] : -1;
      const top = Math.max(skipOld, skipNew, paired);
      let count = 0;
      if (skipOld === top) count += ways[i - 1][j];
      if (skipNew === top) count += ways[i][j - 1];
      if (skipOld === top && skipNew === top && best[i - 1][j - 1] === top) count -= ways[i - 1][j - 1];
      if (paired === top) count += ways[i - 1][j - 1];
      best[i][j] = top;
      ways[i][j] = count;
    }
  }
  const pairs: Pair[] = [];
  let i = rows;
  let j = columns;
  while (i > 0 && j > 0) {
    const paired = scores[i - 1][j - 1] > 0 ? best[i - 1][j - 1] + scores[i - 1][j - 1] : -1;
    if (paired === best[i][j]) pairs.unshift([--i, --j]);
    else if (best[i - 1][j] === best[i][j]) i--;
    else j--;
  }
  return { pairs, unique: ways[rows][columns] === 1 };
}

function pairByShared(gap: Gap, oldLines: string[][], newLines: string[][], axis: Axis): Pair[] {
  if (!gap.old.length || !gap.new.length) return [];
  const scores = gap.old.map((o) => gap.new.map((n) => sharedWords(oldLines[o], newLines[n])));
  const { pairs, unique } = bestAlignment(scores);
  if (!unique) {
    throw refusal(
      `The edit cannot be matched to the table: the new ${axis}s ${gap.new.map((n) => n + 1).join(', ')} each share cells with more than one old ${axis}, so it is not clear which ${axis} is edited and which is new. Change one ${axis} at a time: quote only the ${axis}s around that change.`,
    );
  }
  return pairs.map(([o, n]) => [gap.old[o], gap.new[n]]);
}

function twinsOf(oldIndices: number[], newIndices: number[], oldLines: string[][], newLines: string[][]): Pair[] {
  const unused = new Set(newIndices);
  const twins: Pair[] = [];
  for (const o of oldIndices) {
    const twin = [...unused].find((n) => keyOf(newLines[n]) === keyOf(oldLines[o]) && wordsIn(oldLines[o]).length > 0);
    if (twin === undefined) continue;
    unused.delete(twin);
    twins.push([o, twin]);
  }
  return twins;
}

const unpaired = (count: number, pairs: Pair[], side: 0 | 1): number[] => range(0, count).filter((i) => !pairs.some((pair) => pair[side] === i));

/**
 * Pairs the lines (rows, or columns) of the old table with those of the new one.
 * Lines that match exactly are kept; in the gaps between them, old and new lines
 * are paired by the cells they share; a gap that is still unpaired with as many
 * old lines as new ones is paired in order, because that is an edit of every
 * cell of the line. A line that was moved is left unpaired, so it is a delete
 * and an insert. More than one best way to pair a gap is refused.
 */
export function pairLines(oldLines: string[][], newLines: string[][], axis: Axis): Pairing {
  const pairs = exactAnchors(oldLines.map(keyOf), newLines.map(keyOf));
  for (const gap of gapsAround(pairs, oldLines.length, newLines.length)) pairs.push(...pairByShared(gap, oldLines, newLines, axis));
  const twins = twinsOf(unpaired(oldLines.length, pairs, 0), unpaired(newLines.length, pairs, 1), oldLines, newLines);
  const moved = { old: new Set(twins.map(([o]) => o)), new: new Set(twins.map(([, n]) => n)) };
  for (const gap of gapsAround(pairs, oldLines.length, newLines.length)) {
    const edited = { old: gap.old.filter((o) => !moved.old.has(o)), new: gap.new.filter((n) => !moved.new.has(n)) };
    if (edited.old.length === edited.new.length) pairs.push(...edited.old.map((o, i): Pair => [o, edited.new[i]]));
  }
  return {
    forOld: range(0, oldLines.length).map((o) => pairs.find((pair) => pair[0] === o)?.[1]),
    forNew: range(0, newLines.length).map((n) => pairs.find((pair) => pair[1] === n)?.[0]),
  };
}

/** The old lines that are deleted, each with the new line that is its twin (same cells), when that line is inserted: a move. */
export function movedLines(pairing: Pairing, oldLines: string[][], newLines: string[][]): number[] {
  const deleted = range(0, oldLines.length).filter((o) => pairing.forOld[o] === undefined);
  const inserted = range(0, newLines.length).filter((n) => pairing.forNew[n] === undefined);
  return twinsOf(deleted, inserted, oldLines, newLines).map(([o]) => o);
}
