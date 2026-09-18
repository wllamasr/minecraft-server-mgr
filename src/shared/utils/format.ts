/**
 * Human-readable byte size, e.g. 1536 → "1.5 KB", 1048576 → "1.0 MB".
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, exp)
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`
}

/**
 * A compact "45% (12.0 MB / 26.7 MB)" style progress string used in
 * provisioning log lines. When the total is unknown (0), only the
 * transferred amount is shown.
 */
export function formatProgress(transferred: number, total: number): string {
  if (total <= 0) return formatBytes(transferred)
  const percent = Math.min(100, Math.round((transferred / total) * 100))
  return `${percent}% (${formatBytes(transferred)} / ${formatBytes(total)})`
}
