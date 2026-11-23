import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import yazl from 'yazl'
import {
  BackupAbortedError,
  extractArchive,
  isBackedUpTopLevel,
  planBackup,
  readArchiveComment,
  restorableManifest,
  swapIntoServerDir,
  writeArchive
} from './backup-archive'

let work: string
let server: string

function put(rel: string, content: string | Buffer = rel): void {
  const full = join(server, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** Every file under a directory, as "relative/path" -> content. */
function snapshot(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      const inner = snapshot(root, child)
      if (Object.keys(inner).length === 0) out[`${child}/`] = ''
      Object.assign(out, inner)
    } else {
      out[child] = readFileSync(join(root, child)).toString('base64')
    }
  }
  return out
}

/** Back the server directory up and return the archive path. */
async function backup(name = 'backup.zip', comment?: string): Promise<string> {
  const dest = join(work, 'backups', name)
  await writeArchive(await planBackup(server), dest, { comment })
  return dest
}

async function restore(zip: string): Promise<void> {
  const stage = join(work, 'stage')
  mkdirSync(stage)
  await extractArchive(zip, stage)
  await swapIntoServerDir(server, stage, join(work, 'aside'))
  rmSync(stage, { recursive: true, force: true })
}

/** Write a zip by hand, to play a tampered backup. */
function craftZip(dest: string, build: (zip: yazl.ZipFile) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    build(zip)
    zip.end()
    zip.outputStream.pipe(createWriteStream(dest)).on('close', resolve).on('error', reject)
  })
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'msm-backup-'))
  server = join(work, 'server')
  mkdirSync(server)
  put('server.properties', 'server-port=25565\n')
  put('server.jar', Buffer.alloc(2048, 7))
  put('world/level.dat', Buffer.from([1, 2, 3, 4]))
  put('world/region/r.0.0.mca', Buffer.alloc(70_000, 9))
  put('world/session.lock', 'locked')
  put('plugins/Essentials/config.yml', 'a: 1\n'.repeat(500))
  mkdirSync(join(server, 'world/datapacks'), { recursive: true })
  put('logs/latest.log', 'old log')
  put('libraries/net/lib.jar', 'lib')
  put('versions/1.21.4/server.jar', 'bundled')
})

afterEach(() => {
  rmSync(work, { recursive: true, force: true })
})

describe('isBackedUpTopLevel', () => {
  it('covers the world, settings and add-ons but not what the server regenerates', () => {
    for (const name of ['world', 'world_nether', 'server.properties', 'plugins', 'mods', 'config', 'server.jar']) {
      expect(isBackedUpTopLevel(name), name).toBe(true)
    }
    for (const name of ['logs', 'Logs', 'libraries', 'versions', 'cache', 'crash-reports', 'modpack.mrpack', '', '.', '..']) {
      expect(isBackedUpTopLevel(name), name).toBe(false)
    }
  })
})

describe('planBackup', () => {
  it('lists covered files only, and keeps empty directories', async () => {
    const plan = await planBackup(server)
    const names = plan.files.map((f) => f.rel).sort()
    expect(names).toEqual([
      'plugins/Essentials/config.yml',
      'server.jar',
      'server.properties',
      'world/level.dat',
      'world/region/r.0.0.mca'
    ])
    expect(plan.emptyDirs).toEqual(['world/datapacks'])
    expect(plan.totalBytes).toBe(plan.files.reduce((sum, f) => sum + f.size, 0))
  })
})

describe('backup and restore', () => {
  it('brings the covered files back exactly and leaves the rest alone', async () => {
    const before = snapshot(server)
    const zip = await backup()
    expect(existsSync(`${zip}.part`)).toBe(false)

    // The world moves on after the backup...
    put('world/level.dat', 'changed')
    put('world/region/r.1.0.mca', 'a region generated later')
    rmSync(join(server, 'world/region/r.0.0.mca'))
    rmSync(join(server, 'plugins'), { recursive: true })
    put('new-top-level.txt', 'added later')
    // ...and so does what backups do not cover.
    put('logs/latest.log', 'new log')
    put('logs/2026-01-01.log', 'another')

    await restore(zip)

    const after = snapshot(server)
    const expected = { ...before }
    // session.lock is never in a backup; the server recreates it.
    delete expected['world/session.lock']
    expected['logs/latest.log'] = Buffer.from('new log').toString('base64')
    expected['logs/2026-01-01.log'] = Buffer.from('another').toString('base64')
    expect(after).toEqual(expected)
    expect(existsSync(join(work, 'aside'))).toBe(false)
  })

  it('keeps file times', async () => {
    const zip = await backup()
    const original = statSync(join(server, 'world/level.dat')).mtimeMs
    await restore(zip)
    // Zip times have a resolution of two seconds.
    expect(Math.abs(statSync(join(server, 'world/level.dat')).mtimeMs - original)).toBeLessThan(2500)
  })

  it('stores a comment and reads it back', async () => {
    const zip = await backup('with-comment.zip', JSON.stringify({ format: 1, serverName: 'Test' }))
    expect(JSON.parse(await readArchiveComment(zip))).toEqual({ format: 1, serverName: 'Test' })
    expect(await readArchiveComment(await backup('plain.zip'))).toBe('')
  })

  it('reports progress up to the total', async () => {
    const plan = await planBackup(server)
    let last = 0
    await writeArchive(plan, join(work, 'p.zip'), { onProgress: (p) => (last = p.doneBytes) })
    expect(last).toBe(plan.totalBytes)
  })

  it('leaves no partial archive behind when it is cancelled', async () => {
    const controller = new AbortController()
    const plan = await planBackup(server)
    const dest = join(work, 'cancelled.zip')
    const pending = writeArchive(plan, dest, {
      signal: controller.signal,
      onProgress: () => controller.abort('the server is stopping')
    })
    await expect(pending).rejects.toBeInstanceOf(BackupAbortedError)
    await expect(pending).rejects.toThrow(/the server is stopping/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('fails, without hanging or leaving a partial archive, when a file disappears', async () => {
    const plan = await planBackup(server)
    rmSync(join(server, 'world/region/r.0.0.mca'))
    const dest = join(work, 'vanished.zip')
    await expect(writeArchive(plan, dest)).rejects.toThrow('Could not read world/region/r.0.0.mca')
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('releases the files when cancelled, so the world can be moved', async () => {
    put('world/region/big.mca', Buffer.alloc(8 * 1024 * 1024, 5))
    const controller = new AbortController()
    const plan = await planBackup(server)
    await expect(
      writeArchive(plan, join(work, 'c.zip'), { signal: controller.signal, onProgress: () => controller.abort() })
    ).rejects.toBeInstanceOf(BackupAbortedError)
    // The handles close shortly after the failure, not within it.
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(join(server, 'world'), join(server, 'world-moved'))
        break
      } catch (err) {
        if (attempt >= 40) throw err
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    expect(existsSync(join(server, 'world-moved/level.dat'))).toBe(true)
  })

  it('fails cleanly on a comment the zip format cannot hold', async () => {
    const plan = await planBackup(server)
    const dest = join(work, 'bad-comment.zip')
    await expect(writeArchive(plan, dest, { comment: 'сервер' })).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('refuses to start when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(planBackup(server, controller.signal)).rejects.toBeInstanceOf(BackupAbortedError)
  })
})

describe('extractArchive', () => {
  it('rejects names Windows would read as another path', async () => {
    for (const name of ['logs./x.log', 'world/level.dat.', 'world /level.dat', 'world/level.dat:stream']) {
      const zip = join(work, 'odd.zip')
      await craftZip(zip, (z) => z.addBuffer(Buffer.from('x'), name))
      const stage = join(work, 'stage-odd')
      mkdirSync(stage)
      await expect(extractArchive(zip, stage), name).rejects.toThrow(/not allowed|do not cover/)
      expect(readdirSync(stage)).toEqual([])
      rmSync(stage, { recursive: true })
      rmSync(zip)
    }
  })

  it('rejects an archive with a path backups do not cover, writing nothing', async () => {
    const zip = join(work, 'tampered.zip')
    await craftZip(zip, (z) => {
      z.addBuffer(Buffer.from('fine'), 'world/level.dat')
      z.addBuffer(Buffer.from('evil'), 'libraries/net/lib.jar')
    })
    const stage = join(work, 'stage')
    mkdirSync(stage)
    await expect(extractArchive(zip, stage)).rejects.toThrow(/do not cover/)
    expect(readdirSync(stage)).toEqual([])
  })

  it('rejects an archive that contains a link', async () => {
    const zip = join(work, 'link.zip')
    await craftZip(zip, (z) => z.addBuffer(Buffer.from('/etc/passwd'), 'world/link', { mode: 0o120777 }))
    const stage = join(work, 'stage')
    mkdirSync(stage)
    await expect(extractArchive(zip, stage)).rejects.toThrow(/link/)
    expect(readdirSync(stage)).toEqual([])
  })

  it('rejects a file that is not a zip', async () => {
    const zip = join(work, 'garbage.zip')
    writeFileSync(zip, 'this is not a zip archive at all')
    const stage = join(work, 'stage')
    mkdirSync(stage)
    await expect(extractArchive(zip, stage)).rejects.toThrow()
  })
})

describe('restorableManifest', () => {
  it('accepts the manifest of a real backup', () => {
    expect(restorableManifest(JSON.stringify({ format: 1, fileCount: 12, totalBytes: 3456, serverName: 'x' }))).toEqual({
      fileCount: 12,
      totalBytes: 3456
    })
  })

  it('refuses an archive that is not a backup or says nothing about its content', () => {
    for (const comment of ['', 'not json', 'null', '[]', '"text"', '{}', '{"fileCount":0,"totalBytes":0}']) {
      expect(() => restorableManifest(comment), comment).toThrow(/damaged/)
    }
    expect(() => restorableManifest('{"fileCount":3}')).toThrow(/damaged/)
    expect(() => restorableManifest('{"fileCount":"3","totalBytes":10}')).toThrow(/damaged/)
    expect(() => restorableManifest('{"fileCount":1.5,"totalBytes":10}')).toThrow(/damaged/)
  })
})

describe('swapIntoServerDir', () => {
  it('puts everything back when a staged entry cannot be moved in', async () => {
    const before = snapshot(server)
    const stage = join(work, 'stage')
    mkdirSync(join(stage, 'world'), { recursive: true })
    writeFileSync(join(stage, 'world/level.dat'), 'from the backup')
    // "logs" is not covered, so the server keeps its own: moving a staged
    // "logs" in collides with it and the swap fails halfway.
    mkdirSync(join(stage, 'logs'))
    writeFileSync(join(stage, 'logs/x.log'), 'x')

    await expect(swapIntoServerDir(server, stage, join(work, 'aside'))).rejects.toThrow(/Could not replace/)
    expect(snapshot(server)).toEqual(before)
    expect(existsSync(join(work, 'aside'))).toBe(false)
  })

  it('refuses to run over the leftovers of an interrupted restore', async () => {
    const stage = join(work, 'stage')
    mkdirSync(stage)
    mkdirSync(join(work, 'aside'))
    const before = snapshot(server)
    await expect(swapIntoServerDir(server, stage, join(work, 'aside'))).rejects.toThrow()
    expect(snapshot(server)).toEqual(before)
  })
})
