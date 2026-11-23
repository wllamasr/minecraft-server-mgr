/**
 * Recognise the console lines a Minecraft server prints in answer to the save
 * commands a backup sends (`save-off`, `save-all flush`).
 *
 * Only the server's own output counts. A log line is a run of `[...]` groups
 * (time, thread, level, sometimes a logger name), a colon, and the message.
 * A chat message or a `/say` puts something between the colon and the text
 * (`<Steve>`, `[Server]`, `[Not Secure]`), so a player typing "Saved the game"
 * can never be taken for the server's confirmation.
 */

function serverMessage(line: string): string | null {
  const match = /^(?:\[[^\]]*\]\s*)+:\s(.*?)\s*$/.exec(line)
  return match ? match[1] : null
}

/** What the server answered to `save-off`, or null when the line is not that answer. */
export function saveOffAnswer(line: string): 'disabled' | 'already-off' | null {
  const message = serverMessage(line)
  if (message === null) return null
  // Current servers, then 1.12 and older.
  if (message === 'Automatic saving is now disabled' || message === 'Turned off world auto-saving') return 'disabled'
  if (message === 'Saving is already turned off') return 'already-off'
  return null
}

/** Whether the line is the server confirming that `save-all` has finished. */
export function isSaveFinishedLine(line: string): boolean {
  const message = serverMessage(line)
  return message === 'Saved the game' || message === 'Saved the world'
}
