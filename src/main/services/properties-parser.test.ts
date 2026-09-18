import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readProperties, saveProperties } from './properties-parser'

describe('properties-parser', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'msm-props-'))
    file = join(dir, 'server.properties')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('readProperties', () => {
    it('parses key=value pairs', () => {
      writeFileSync(file, 'server-port=25565\nmotd=Hello World\nmax-players=20\n')
      const props = readProperties(file)
      expect(props['server-port']).toBe('25565')
      expect(props['motd']).toBe('Hello World')
      expect(props['max-players']).toBe('20')
    })

    it('ignores comments and blank lines', () => {
      writeFileSync(file, '#Minecraft server properties\n#Fri Sep 18\n\npvp=true\n')
      const props = readProperties(file)
      expect(props).toEqual({ pvp: 'true' })
    })

    it('keeps values that contain "=" intact', () => {
      writeFileSync(file, 'rcon.password=a=b=c\n')
      const props = readProperties(file)
      expect(props['rcon.password']).toBe('a=b=c')
    })

    it('preserves empty values', () => {
      writeFileSync(file, 'resource-pack=\n')
      const props = readProperties(file)
      expect(props['resource-pack']).toBe('')
    })
  })

  describe('saveProperties', () => {
    it('updates existing keys in place', () => {
      writeFileSync(file, 'server-port=25565\nmotd=old\n')
      saveProperties(file, { motd: 'new' })
      const props = readProperties(file)
      expect(props['motd']).toBe('new')
      expect(props['server-port']).toBe('25565')
    })

    it('preserves comments when rewriting', () => {
      writeFileSync(file, '#header comment\nserver-port=25565\n')
      saveProperties(file, { 'server-port': '25566' })
      const raw = readFileSync(file, 'utf-8')
      expect(raw).toContain('#header comment')
      expect(raw).toContain('server-port=25566')
    })

    it('appends new keys not present in the original file', () => {
      writeFileSync(file, 'server-port=25565\n')
      saveProperties(file, { difficulty: 'hard' })
      const props = readProperties(file)
      expect(props['difficulty']).toBe('hard')
      expect(props['server-port']).toBe('25565')
    })

    it('is stable across a read/save round-trip', () => {
      writeFileSync(file, '#comment\nserver-port=25565\nmotd=Test\n')
      const before = readProperties(file)
      saveProperties(file, before)
      const after = readProperties(file)
      expect(after).toEqual(before)
    })
  })
})
