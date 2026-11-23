import { describe, it, expect } from 'vitest'
import { isSaveFinishedLine, saveOffAnswer } from './save-lines'

describe('save confirmation lines', () => {
  it('recognises the server answer in the log formats in use', () => {
    for (const line of [
      '[12:00:00] [Server thread/INFO]: Saved the game',
      '[12:00:00 INFO]: Saved the game',
      '[12:00:00] [Server thread/INFO] [minecraft/MinecraftServer]: Saved the game',
      '[12:00:00] [Server thread/INFO]: Saved the game\r',
      '[12:00:00] [Server thread/INFO]: Saved the world'
    ]) {
      expect(isSaveFinishedLine(line), line).toBe(true)
    }
  })

  it('is not fooled by chat, /say or other output', () => {
    for (const line of [
      '[12:00:00] [Server thread/INFO]: <Steve> Saved the game',
      '[12:00:00] [Server thread/INFO]: [Not Secure] <Steve> Saved the game',
      '[12:00:00] [Server thread/INFO]: [Server] Saved the game',
      '[12:00:00 INFO]: [Steve: Saved the game]',
      '[12:00:00] [Server thread/INFO]: Saving the game (this may take a moment!)',
      '[12:00:00] [Server thread/INFO]: Saved the game now',
      'Saved the game',
      ''
    ]) {
      expect(isSaveFinishedLine(line), line).toBe(false)
    }
  })

  it('tells whether saving was on before save-off', () => {
    expect(saveOffAnswer('[12:00:00] [Server thread/INFO]: Automatic saving is now disabled')).toBe('disabled')
    expect(saveOffAnswer('[12:00:00 INFO]: Saving is already turned off')).toBe('already-off')
    expect(saveOffAnswer('[12:00:00] [Server thread/INFO]: Turned off world auto-saving')).toBe('disabled')
    expect(saveOffAnswer('[12:00:00] [Server thread/INFO]: <Steve> Saving is already turned off')).toBeNull()
    expect(saveOffAnswer('[12:00:00] [Server thread/INFO]: Saved the game')).toBeNull()
  })
})
