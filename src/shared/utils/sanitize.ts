/**
 * Convert an arbitrary server name into a filesystem-safe directory name.
 *
 * Any character outside `[a-zA-Z0-9_-]` is replaced with an underscore so the
 * name can be used as a folder under the servers root directory without
 * risking path traversal or invalid characters on Windows.
 */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}
