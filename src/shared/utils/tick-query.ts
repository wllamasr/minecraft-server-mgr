/**
 * How fast a Minecraft server is ticking, read from its own answer to the
 * `tick query` command (Minecraft 1.20.3 and newer).
 *
 * The answer is four lines, the second and third being one message:
 *
 *     [19:25:33 INFO]: The game is running normally
 *     [19:25:33 INFO]: Target tick rate: 20.0 per second.
 *     Average time per tick: 0.4ms (Target: 50.0ms)
 *     [19:25:33 INFO]: Percentiles: P50: 0.3ms P95: 0.5ms P99: 0.7ms. Sample: 100
 *
 * (Captured from Paper 1.21.11; see __fixtures__/tick-query-paper-1.21.11.txt.)
 * While the game is sprinting (`/tick sprint`) the rate line ends in
 * "(ignored, reference only)." and the average comes without a target; see
 * __fixtures__/tick-query-paper-1.21.11-modes.txt for that, a frozen game and
 * another tick rate.
 *
 * Only the server's own output counts, as for the save commands
 * (save-lines.ts): a chat message or a `/say` puts something between the
 * colon and the text, so a player cannot type a tick time into the panel. The
 * line without a prefix is only accepted right after the one it continues.
 */

/** One answer to `tick query`. Times are milliseconds per tick. */
export interface TickSample {
  /** Average time the server needs for one tick. */
  averageMs: number
  /** The time one tick may take at the target rate (50 ms at 20 per second). */
  targetMs: number
  /** Ticks per second the server aims for (20 unless changed with `/tick rate`). */
  targetRate: number
  /**
   * Ticks per second the server can actually do: the target rate, or less
   * when a tick takes longer than its share. Never more than the target.
   * Absent while sprinting: the target is ignored then.
   */
  tps?: number
  /** What the game was doing: ticking normally, sprinting or frozen (`/tick`). */
  mode: 'normal' | 'sprinting' | 'frozen'
  p50Ms?: number
  p95Ms?: number
  p99Ms?: number
  /** How many ticks the numbers are taken over. */
  sampleSize?: number
}

/** `tick query` exists since Minecraft 1.20.3. */
export function supportsTickQuery(mcVersion: string): boolean {
  // "1.21.4", "26.1", and pre-releases of those ("1.21.5-rc1"). Snapshot
  // names ("24w10a") say nothing about the version: no.
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-+ ])/.exec(String(mcVersion).trim())
  if (!match) return false
  const [first, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
  if (first >= 2) return true // year-based versions (26.1, ...)
  if (first < 1) return false
  if (minor > 20) return true
  return minor === 20 && patch >= 3
}

const ANSI = /\u001b\[[0-9;]*m/g

function clean(line: string): string {
  return line.replace(ANSI, '').replace(/\r$/, '')
}

/** The message of a line the server itself logged, or null for anything else. */
function serverMessage(line: string): string | null {
  const match = /^(?:\[[^\]]*\]\s*)+:\s(.*?)\s*$/.exec(line)
  return match ? match[1] : null
}

/** A number as the server prints it. Some builds use the system's decimal comma. */
function num(text: string): number {
  return Number(text.replace(',', '.'))
}

/**
 * The line a server prints when it has finished starting and reads its
 * console: `Done (11.138s)! For help, type "help"`.
 */
export function isServerReadyLine(line: string): boolean {
  const message = serverMessage(clean(line))
  return message !== null && /^Done \(\d/.test(message)
}

const NUMBER = '(\\d+(?:[.,]\\d+)?)'
const RATE = new RegExp(`^Target tick rate: ${NUMBER} per second( \\(ignored, reference only\\))?\\.?$`)
const AVERAGE = new RegExp(`^Average time per tick: ${NUMBER}ms(?: \\(Target: ${NUMBER}ms\\))?$`)
const STATUS = /^The game is (running normally|sprinting|frozen)\b/
const PERCENTILES = new RegExp(`^Percentiles: P50: ${NUMBER}ms P95: ${NUMBER}ms P99: ${NUMBER}ms[.,] sample: (\\d+)$`, 'i')

export interface TickQueryLine {
  /** The line is part of an answer to `tick query`. */
  part: boolean
  /** Set on the lines that complete a sample (the average, then the percentiles). */
  sample?: TickSample
  /** The answer is complete: nothing more belongs to it. */
  end?: boolean
}

/**
 * Reads the answers to `tick query` out of a server's console, line by line.
 * Feed it every line the server prints, in order.
 */
export function createTickQueryReader(): { feed(line: string): TickQueryLine } {
  let state: 'idle' | 'status' | 'rate' | 'average' = 'idle'
  let rate = 0
  let mode: TickSample['mode'] = 'normal'
  let sample: TickSample | null = null

  const feed = (raw: string): TickQueryLine => {
    const line = clean(raw)
    const message = serverMessage(line)

    if (state === 'rate') {
      // The second line of the message that began with the target rate. It
      // has no prefix of its own (some consoles repeat it).
      const match = AVERAGE.exec(message ?? line.trim())
      if (match) {
        const averageMs = num(match[1])
        // A sprinting game is not held to its target, and does not print it.
        const targetMs = match[2] !== undefined ? num(match[2]) : 1000 / rate
        sample = { averageMs, targetMs, targetRate: rate, mode }
        if (mode !== 'sprinting') {
          sample.tps = Math.min(rate, averageMs > targetMs && averageMs > 0 ? 1000 / averageMs : rate)
        }
        state = 'average'
        return { part: true, sample: { ...sample } }
      }
    } else if (state === 'average' && message !== null && sample) {
      const match = PERCENTILES.exec(message)
      if (match) {
        const full: TickSample = {
          ...sample,
          p50Ms: num(match[1]),
          p95Ms: num(match[2]),
          p99Ms: num(match[3]),
          sampleSize: Number(match[4])
        }
        state = 'idle'
        sample = null
        return { part: true, sample: full, end: true }
      }
    }

    // Not the continuation that was expected: whatever this line is, it is
    // looked at as the possible start of an answer.
    const wasOpen = state !== 'idle'
    // What the line before said the game is doing, if it said so.
    const said: TickSample['mode'] = state === 'status' ? mode : 'normal'
    state = 'idle'
    sample = null
    if (message !== null) {
      const match = RATE.exec(message)
      if (match && num(match[1]) > 0) {
        rate = num(match[1])
        mode = match[2] ? 'sprinting' : said
        state = 'rate'
        return { part: true }
      }
      const status = STATUS.exec(message)
      if (status) {
        mode = status[1] === 'sprinting' ? 'sprinting' : status[1] === 'frozen' ? 'frozen' : 'normal'
        state = 'status'
        return { part: true }
      }
    }
    return wasOpen ? { part: false, end: true } : { part: false }
  }

  return { feed }
}

/** How long after a question the server's answer is taken for the answer to it. */
export const TICK_ANSWER_WINDOW_MS = 3000

/**
 * Tells the answers to the app's own questions from everything else in a
 * server's console, so that they can be kept out of the console the app
 * shows. Only the first answer that begins shortly after a question is the
 * app's: what the server answers to a `tick query` somebody typed, or a
 * plugin sent, is theirs to see. Every answer is read, whoever asked.
 */
export function createTickAnswerFilter(): {
  /** The app has just asked. */
  asked(now: number): void
  /** A line the server printed. `own`: it is part of the answer to the app. */
  feed(line: string, now: number): { own: boolean; sample?: TickSample }
} {
  const reader = createTickQueryReader()
  let expectedUntil = 0
  let inOwnAnswer = false
  return {
    asked(now) {
      inOwnAnswer = false
      expectedUntil = now + TICK_ANSWER_WINDOW_MS
    },
    feed(line, now) {
      const read = reader.feed(line)
      if (read.part && !inOwnAnswer && now < expectedUntil) {
        inOwnAnswer = true
        expectedUntil = 0
      }
      const own = read.part && inOwnAnswer
      if (read.end || !read.part) inOwnAnswer = false
      return read.sample ? { own, sample: read.sample } : { own }
    }
  }
}

/** How often the server is asked while someone is looking. */
export const TICK_QUERY_INTERVAL_MS = 15_000
/**
 * How long one "someone is looking" lasts. Whoever shows the numbers says so
 * again every few seconds; when it stops saying so (the page was left, the
 * window closed, the renderer crashed), the asking stops by itself.
 */
export const TICK_WATCH_LEASE_MS = 15_000
/** After this many questions in a row without an answer the server is left alone. */
export const TICK_QUERY_MAX_MISSES = 3
/** A sample older than this is no longer shown as the current state. */
export const TICK_SAMPLE_MAX_AGE_MS = 45_000

/**
 * Decides when a running server is asked for its tick time.
 *
 * Every question puts four lines into the server's own log file, so it is
 * only asked while its numbers are on screen, never before it has finished
 * starting, and no more once it has shown that it does not answer (a server
 * software without the command, or with another wording). An answer that
 * does come after that, to a question somebody typed for instance, shows
 * that it answers after all, and the asking starts again.
 */
export class TickQueryPolicy {
  private watchedUntil = 0
  private ready = false
  private lastAsked = -Infinity
  private waiting = false
  private misses = 0

  constructor(private readonly supported: boolean) {}

  /** Someone is looking at the numbers now. */
  watch(now: number): void {
    this.watchedUntil = now + TICK_WATCH_LEASE_MS
  }

  /** The server has finished starting and reads its console. */
  serverReady(): void {
    this.ready = true
  }

  isWatched(now: number): boolean {
    return now < this.watchedUntil
  }

  /** Why the server is not asked at all, if it is not. */
  get status(): 'unsupported' | 'unavailable' | undefined {
    if (!this.supported) return 'unsupported'
    return this.misses >= TICK_QUERY_MAX_MISSES ? 'unavailable' : undefined
  }

  /** Whether to ask now. `running` is false while the server is stopping. */
  shouldAsk(now: number, running: boolean): boolean {
    if (!this.supported || !this.ready || !running) return false
    if (!this.isWatched(now)) return false
    // The last question went unanswered for a whole interval.
    if (this.waiting && now - this.lastAsked >= TICK_QUERY_INTERVAL_MS) {
      this.waiting = false
      this.misses++
    }
    if (this.misses >= TICK_QUERY_MAX_MISSES) return false
    return !this.waiting && now - this.lastAsked >= TICK_QUERY_INTERVAL_MS
  }

  /** The question was sent. */
  asked(now: number): void {
    this.lastAsked = now
    this.waiting = true
  }

  /** An answer came. */
  answered(): void {
    this.waiting = false
    this.misses = 0
  }
}
