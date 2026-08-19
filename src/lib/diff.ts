export interface DiffFile {
  path: string;
  additions: number;
  deletions: number;
  content: string;
}

/** Splits a unified `git diff` into per-file sections with +/- line counts. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        path: match?.[2] ?? match?.[1] ?? "?",
        additions: 0,
        deletions: 0,
        content: `${line}\n`,
      };
      continue;
    }
    if (current) {
      current.content += `${line}\n`;
      if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
    }
  }
  if (current) files.push(current);
  return files;
}
