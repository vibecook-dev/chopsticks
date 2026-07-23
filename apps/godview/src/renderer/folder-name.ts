/** Return only the final path component used by circles and pane badges. */
export function folderName(path: string | null | undefined, fallback: string): string {
  const normalized = path?.trim().replace(/[\\/]+$/, '') ?? '';
  return normalized.split(/[\\/]/).pop() || fallback;
}
