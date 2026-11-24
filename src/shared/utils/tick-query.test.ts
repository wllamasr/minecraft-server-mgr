import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createTickAnswerFilter,
  createTickQueryReader,
  isServerReadyLine,
  TICK_ANSWER_WINDOW_MS,
  supportsTickQuery,
  TICK_QUERY_INTERVAL_MS,
  TICK_QUERY_MAX_MISSES,
  TICK_WATCH_LEASE_MS,
  TickQueryPolicy,
  type TickQueryLine,
  type TickSample
} from './tick-query'

function read(lines: string[]): { results: TickQueryLine[]; samples: TickSample[]; hidden: string[] } {
  const reader = createTickQueryReader()
  const results = lines.map((line) => reader.feed(line))
  return {
    results,
    samples: results.flatMap((r) => (r.sample ? [r.sample] : [])),
    hidden: lines.filter((_, i) => results[i].part)
  }
}

describe('supportsTickQuery', () => {
  it('is true from 1.20.3 on, in both numbering schemes', () => {
    for (const version of ['1.20.3', '1.20.4', '1.20.6', '1.21', '1.21.11', '26.1', '26.3.1', '1.21.5-rc1', '1.20.3-pre2']) {
      expect(supportsTickQuery(version), version).toBe(true)
    }
    for (const version of ['1.20.2', '1.20', '1.19.4', '1.8.9', '1.7.10', '24w10a', '', 'latest', '0.9']) {
      expect(supportsTickQuery(version), version).toBe(false)
    }
  })
})

describe('reading what a real server answered', () => {
  // The console of Paper 1.21.11, captured as it came out of the process.
  const lines = readFileSync(join(__dirname, '__fixtures__', 'tick-query-paper-1.21.11.txt'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)

  it('finds both answers and nothing else', () => {
    const { samples, results } = read(lines)
    const complete = samples.filter((s) => s.sampleSize !== undefined)
    expect(complete).toEqual([
      { averageMs: 0.4, targetMs: 50, targetRate: 20, tps: 20, mode: 'normal', p50Ms: 0.3, p95Ms: 0.5, p99Ms: 0.7, sampleSize: 100 },
      { averageMs: 0.1, targetMs: 50, targetRate: 20, tps: 20, mode: 'normal', p50Ms: 0.1, p95Ms: 0.2, p99Ms: 0.4, sampleSize: 100 }
    ])
    expect(results.filter((r) => r.end && r.sample)).toHaveLength(2)
  })

  it('takes exactly the four lines of each answer as part of it', () => {
    const { hidden } = read(lines)
    expect(hidden).toHaveLength(8)
    expect(hidden.every((line) => /The game is|Target tick rate|Average time per tick|Percentiles/.test(line))).toBe(true)
    // What a /say printed is not one of them, nor are other commands' answers.
    expect(hidden.some((line) => line.includes('[Server]'))).toBe(false)
    expect(hidden.some((line) => line.includes('TPS from last'))).toBe(false)
  })
})

describe('reading a real server that sprints, is frozen and changes its tick rate', () => {
  // Paper 1.21.11 again: tick query after `tick sprint`, `tick freeze`,
  // `tick step` and `tick rate 40`, with what those commands answered.
  const lines = readFileSync(join(__dirname, '__fixtures__', 'tick-query-paper-1.21.11-modes.txt'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)

  it('reads every answer, in whatever state the game is', () => {
    const complete = read(lines).samples.filter((s) => s.sampleSize !== undefined)
    expect(complete.map((s) => s.mode)).toEqual(['normal', 'sprinting', 'frozen', 'frozen', 'normal'])
    // Sprinting: no target is printed and none holds; no ticks per second.
    expect(complete[1]).toEqual({
      averageMs: 0, targetMs: 50, targetRate: 20, mode: 'sprinting', p50Ms: 0, p95Ms: 0, p99Ms: 0, sampleSize: 100
    })
    expect(complete[2]).toMatchObject({ averageMs: 0.1, targetMs: 50, tps: 20 })
    // `tick rate 40`: the target is read from the answer, not assumed.
    expect(complete[4]).toMatchObject({ targetRate: 40, targetMs: 25, tps: 40, averageMs: 0.1 })
  })

  it('takes no line of another command for part of an answer, but for the state lines', () => {
    const { hidden } = read(lines)
    const other = hidden.filter((line) => !/Target tick rate|Average time per tick|Percentiles/.test(line))
    expect(other.every((line) => /: The game is (running normally|sprinting|frozen)$/.test(line))).toBe(true)
    expect(other.length).toBeGreaterThan(0)
    expect(hidden.some((line) => /Sprint completed|Stepping|Set the target/.test(line))).toBe(false)
  })
})

describe('createTickQueryReader', () => {
  const rate = '[12:00:00] [Server thread/INFO]: Target tick rate: 20.0 per second.'
  const average = 'Average time per tick: 62.5ms (Target: 50.0ms)'
  const percentiles = '[12:00:00] [Server thread/INFO]: Percentiles: P50: 60.0ms P95: 80.5ms P99: 120.0ms, sample: 100'

  it('reads the vanilla log format and a server that cannot keep up', () => {
    const { samples } = read([rate, average, percentiles])
    expect(samples[1]).toEqual({
      averageMs: 62.5, targetMs: 50, targetRate: 20, tps: 16, mode: 'normal', p50Ms: 60, p95Ms: 80.5, p99Ms: 120, sampleSize: 100
    })
  })

  it('reports the average at once and the percentiles when they come', () => {
    const { results } = read([rate, average, '[12:00:01] [Server thread/INFO]: Steve joined the game'])
    expect(results[1].sample).toEqual({ averageMs: 62.5, targetMs: 50, targetRate: 20, tps: 16, mode: 'normal' })
    expect(results[1].end).toBeUndefined()
    // The answer is over without percentiles; the next line is not part of it.
    expect(results[2]).toEqual({ part: false, end: true })
  })

  it('never reports more ticks per second than the target', () => {
    const { samples } = read([rate, 'Average time per tick: 0.0ms (Target: 50.0ms)'])
    expect(samples[0].tps).toBe(20)
    const sprint = read(['[12:00:00] [Server thread/INFO]: Target tick rate: 100.0 per second.', 'Average time per tick: 4.0ms (Target: 10.0ms)'])
    expect(sprint.samples[0]).toMatchObject({ targetRate: 100, targetMs: 10, tps: 100 })
  })

  it('accepts a decimal comma and colour codes', () => {
    const { samples } = read([
      '[12:00:00 INFO]: \u001b[38;5;3mTarget tick rate: 20,0 per second.\u001b[0m',
      'Average time per tick: 100,0ms (Target: 50,0ms)\r'
    ])
    expect(samples[0]).toEqual({ averageMs: 100, targetMs: 50, targetRate: 20, tps: 10, mode: 'normal' })
  })

  it('accepts the second line with a prefix of its own', () => {
    const { samples } = read([rate, '[12:00:00] [Server thread/INFO]: ' + average])
    expect(samples).toHaveLength(1)
  })

  it('is not fooled by what players or plugins print', () => {
    const fakes = [
      // No server said the target rate first.
      average,
      '[12:00:00] [Server thread/INFO]: ' + average,
      // Chat and /say put a name between the colon and the text.
      '[12:00:00] [Server thread/INFO]: <Steve> Target tick rate: 20.0 per second.',
      average,
      '[12:00:00] [Server thread/INFO]: [Not Secure] [Server] Target tick rate: 20.0 per second.',
      average,
      // Something else came in between.
      rate,
      '[12:00:00] [Server thread/INFO]: Steve joined the game',
      average,
      // Percentiles alone.
      percentiles
    ]
    const { samples, hidden } = read(fakes)
    expect(samples).toEqual([])
    expect(hidden).toEqual([rate])
  })

  it('reads the answer of a server that cannot keep up', () => {
    // Wording from the game's language file; not captured from a server.
    const { samples, hidden } = read([
      "[12:00:00] [Server thread/INFO]: The game is running, but can't keep up with the target tick rate",
      rate,
      average,
      percentiles
    ])
    expect(hidden).toHaveLength(4)
    expect(samples[1]).toMatchObject({ mode: 'normal', averageMs: 62.5, tps: 16 })
  })

  it('takes no number of an absurd length', () => {
    const { samples } = read([rate, `Average time per tick: ${'9'.repeat(400)}ms (Target: 50.0ms)`])
    expect(samples).toEqual([])
  })

  it('starts over when a new answer begins inside an unfinished one', () => {
    const { samples } = read([rate, rate, average, percentiles])
    expect(samples).toHaveLength(2)
    expect(samples[1].sampleSize).toBe(100)
  })
})

describe('isServerReadyLine', () => {
  it('knows the line a started server prints, and only from the server', () => {
    expect(isServerReadyLine('[19:25:27 INFO]: Done (11.138s)! For help, type "help"')).toBe(true)
    expect(isServerReadyLine('[12:00:00] [Server thread/INFO] [minecraft/DedicatedServer]: Done (4.2s)! For help, type "help"')).toBe(true)
    expect(isServerReadyLine('[12:00:00] [Server thread/INFO]: <Steve> Done (1s)!')).toBe(false)
    expect(isServerReadyLine('[12:00:00] [Server thread/INFO]: Done preparing level')).toBe(false)
    expect(isServerReadyLine('Done (1s)!')).toBe(false)
  })
})

describe('createTickAnswerFilter', () => {
  const answer = [
    '[19:25:33 INFO]: The game is running normally',
    '[19:25:33 INFO]: Target tick rate: 20.0 per second.',
    'Average time per tick: 0.4ms (Target: 50.0ms)',
    '[19:25:33 INFO]: Percentiles: P50: 0.3ms P95: 0.5ms P99: 0.7ms. Sample: 100'
  ]
  const chat = '[19:25:34 INFO]: <Steve> hello'

  it('takes the answer to its own question, and nothing after it', () => {
    const filter = createTickAnswerFilter()
    filter.asked(1000)
    const own = [chat, ...answer, chat, ...answer].map((line) => filter.feed(line, 1100).own)
    expect(own).toEqual([false, true, true, true, true, false, false, false, false, false])
  })

  it('leaves alone the answer to a question somebody else asked, and still reads it', () => {
    const filter = createTickAnswerFilter()
    const typed = answer.map((line) => filter.feed(line, 500))
    expect(typed.map((r) => r.own)).toEqual([false, false, false, false])
    expect(typed[3].sample?.p95Ms).toBe(0.5)

    // Asked, but the server answered too late to be sure it is ours.
    filter.asked(1000)
    const late = answer.map((line) => filter.feed(line, 1000 + TICK_ANSWER_WINDOW_MS))
    expect(late.map((r) => r.own)).toEqual([false, false, false, false])
  })

  it('stops at the end of an answer that came without percentiles', () => {
    const filter = createTickAnswerFilter()
    filter.asked(0)
    const own = [answer[1], answer[2], chat, ...answer].map((line) => filter.feed(line, 10).own)
    expect(own).toEqual([true, true, false, false, false, false, false])
  })

  it('does not take a line that only resembles the start of an answer', () => {
    const filter = createTickAnswerFilter()
    filter.asked(0)
    expect(filter.feed('[19:25:33 INFO]: The game is over, thanks for playing', 10).own).toBe(false)
    expect(answer.map((line) => filter.feed(line, 20).own)).toEqual([true, true, true, true])
  })

  it('takes one answer per question', () => {
    const filter = createTickAnswerFilter()
    filter.asked(0)
    expect(answer.map((line) => filter.feed(line, 10).own)).toEqual([true, true, true, true])
    filter.asked(20_000)
    expect(answer.map((line) => filter.feed(line, 20_010).own)).toEqual([true, true, true, true])
  })
})

describe('TickQueryPolicy', () => {
  const every = TICK_QUERY_INTERVAL_MS

  it('asks only while someone is looking, and stops by itself when they stop saying so', () => {
    const policy = new TickQueryPolicy(true)
    policy.serverReady()
    expect(policy.shouldAsk(0, true)).toBe(false) // nobody looking

    policy.watch(1000)
    expect(policy.shouldAsk(1000, true)).toBe(true)
    policy.asked(1000)
    policy.answered()
    expect(policy.shouldAsk(1000 + every - 1, true)).toBe(false) // too soon; also the lease is still on
    // Nobody renewed: the lease has run out, however long ago the last question was.
    expect(policy.isWatched(1000 + TICK_WATCH_LEASE_MS)).toBe(false)
    expect(policy.shouldAsk(1000 + every * 10, true)).toBe(false)

    // Renewed every few seconds: asked once per interval.
    let asked = 0
    for (let now = 100_000; now < 100_000 + every * 4; now += 5000) {
      policy.watch(now)
      if (policy.shouldAsk(now, true)) {
        policy.asked(now)
        policy.answered()
        asked++
      }
    }
    expect(asked).toBe(4)
  })

  it('waits for the server to have started, and leaves a stopping server alone', () => {
    const policy = new TickQueryPolicy(true)
    policy.watch(0)
    expect(policy.shouldAsk(0, true)).toBe(false)
    policy.serverReady()
    expect(policy.shouldAsk(0, false)).toBe(false)
    expect(policy.shouldAsk(0, true)).toBe(true)
  })

  it('never asks a version without the command', () => {
    const policy = new TickQueryPolicy(false)
    policy.serverReady()
    policy.watch(0)
    expect(policy.shouldAsk(0, true)).toBe(false)
    expect(policy.status).toBe('unsupported')
  })

  it('gives up for good after a few questions without an answer', () => {
    const policy = new TickQueryPolicy(true)
    policy.serverReady()
    let asked = 0
    for (let now = 0; now < every * 20; now += 5000) {
      policy.watch(now)
      if (policy.shouldAsk(now, true)) {
        policy.asked(now)
        asked++
      }
    }
    expect(asked).toBe(TICK_QUERY_MAX_MISSES)
    expect(policy.status).toBe('unavailable')
  })

  it('starts asking again when a server it gave up on answers after all', () => {
    const policy = new TickQueryPolicy(true)
    policy.serverReady()
    let now = 0
    for (let i = 0; i < 6; i++, now += every) {
      policy.watch(now)
      if (policy.shouldAsk(now, true)) policy.asked(now)
    }
    expect(policy.status).toBe('unavailable')
    policy.answered() // to a question somebody typed
    policy.watch(now)
    expect(policy.status).toBeUndefined()
    expect(policy.shouldAsk(now, true)).toBe(true)
  })

  it('forgets missed answers once one comes', () => {
    const policy = new TickQueryPolicy(true)
    policy.serverReady()
    let now = 0
    const ask = (answer: boolean): boolean => {
      policy.watch(now)
      const yes = policy.shouldAsk(now, true)
      if (yes) {
        policy.asked(now)
        if (answer) policy.answered()
      }
      now += every
      return yes
    }
    expect(ask(false)).toBe(true)
    expect(ask(false)).toBe(true)
    expect(ask(true)).toBe(true)
    expect(ask(false)).toBe(true)
    expect(ask(false)).toBe(true)
    expect(ask(true)).toBe(true)
    expect(policy.status).toBeUndefined()
  })
})
