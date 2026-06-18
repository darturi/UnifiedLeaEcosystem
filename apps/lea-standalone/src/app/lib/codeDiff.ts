import type { CodeStep } from './api';

export type DiffRowKind = 'unchanged' | 'added' | 'removed';

export interface DiffRow {
  kind: DiffRowKind;
  line: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

function splitCode(code: string): string[] {
  if (!code) {
    return [];
  }
  const lines = code.split('\n');
  if (lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

export function buildInlineDiff(previousCode: string, currentCode: string): DiffRow[] {
  const oldLines = splitCode(previousCode);
  const newLines = splitCode(currentCode);
  const table = Array.from({ length: oldLines.length + 1 }, () =>
    Array(newLines.length + 1).fill(0),
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[oldIndex + 1][newIndex + 1] + 1
          : Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      rows.push({
        kind: 'unchanged',
        line: oldLines[oldIndex],
        oldLineNumber: oldIndex + 1,
        newLineNumber: newIndex + 1,
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      rows.push({
        kind: 'removed',
        line: oldLines[oldIndex],
        oldLineNumber: oldIndex + 1,
      });
      oldIndex += 1;
    } else {
      rows.push({
        kind: 'added',
        line: newLines[newIndex],
        newLineNumber: newIndex + 1,
      });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    rows.push({
      kind: 'removed',
      line: oldLines[oldIndex],
      oldLineNumber: oldIndex + 1,
    });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    rows.push({
      kind: 'added',
      line: newLines[newIndex],
      newLineNumber: newIndex + 1,
    });
    newIndex += 1;
  }

  return rows;
}

export function previousStepForPath(steps: CodeStep[], currentIndex: number): CodeStep | undefined {
  const current = steps[currentIndex];
  if (!current) {
    return undefined;
  }
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    if (steps[index].path === current.path) {
      return steps[index];
    }
  }
  return undefined;
}

export function diffForStep(steps: CodeStep[], currentIndex: number): DiffRow[] {
  const current = steps[currentIndex];
  if (!current) {
    return [];
  }
  const previous = previousStepForPath(steps, currentIndex);
  return buildInlineDiff(previous?.code || '', current.code);
}
