/**
 * Helpers for reasoning about Minecraft version strings.
 *
 * Two numbering schemes exist: the classic `1.MINOR[.PATCH]` (`1.21.4`) and
 * the year-based `YY.DROP[.PATCH]` scheme Mojang adopted in 2026 (`26.1`,
 * `26.3`).
 */

/**
 * Minimum Java major version a Minecraft server needs.
 *
 * Values match the `javaVersion.majorVersion` field Mojang publishes in each
 * version's metadata:
 *
 * | Minecraft          | Java |
 * | ------------------ | ---- |
 * | 26.x and later     | 25   |
 * | 1.20.5 – 1.21.x    | 21   |
 * | 1.17 – 1.20.4      | 17   |
 * | 1.16.5 and earlier | 8    |
 */
export function getRequiredJavaMajor(mcVersion: string): number {
  const parts = String(mcVersion).split('.')
  const num = (s: string | undefined): number => {
    const n = parseInt(s ?? '', 10)
    return Number.isFinite(n) ? n : 0
  }
  const first = num(parts[0])

  // Year-based versions (26.1, 26.3, ...). `1.x` has first === 1.
  if (first >= 2) return first >= 26 ? 25 : 21

  const minor = num(parts[1])
  const patch = num(parts[2])

  if (minor >= 21) return 21
  if (minor === 20 && patch >= 5) return 21
  if (minor >= 17) return 17
  return 8
}

/** True for final releases; false for `-pre`, `-rc` and snapshot builds. */
export function isReleaseVersion(version: string): boolean {
  return /^\d+(\.\d+){1,2}$/.test(version)
}

/** Compare two release versions numerically; newest first when used with sort. */
export function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
