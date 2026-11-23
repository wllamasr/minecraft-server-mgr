/**
 * Only plain web links may be handed to the operating system. Anything else
 * (`file:`, `javascript:`, custom protocol handlers, UNC paths, ...) could
 * launch a local program or open a local file, so it is refused.
 */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.trim() === '') return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}
