/**
 * JVM argument profiles for running a Minecraft server.
 *
 * - `default`: only the heap size (`-Xms` / `-Xmx`). Fine for small servers.
 * - `aikar`: "Aikar's flags", the G1GC tuning PaperMC documents for servers
 *   under load (https://docs.papermc.io/paper/aikars-flags). It trades a
 *   little memory headroom for short, predictable garbage-collection pauses,
 *   which is what keeps tick times stable with many players online.
 */
export type JvmProfile = 'default' | 'aikar'

export const JVM_PROFILES: readonly JvmProfile[] = ['default', 'aikar']

export function isJvmProfile(value: unknown): value is JvmProfile {
  return typeof value === 'string' && (JVM_PROFILES as readonly string[]).includes(value)
}

/**
 * Aikar's flags, exactly as published in the PaperMC documentation (heap size
 * and the jar are added by the caller). Every option is a standard HotSpot G1
 * flag; `UnlockExperimentalVMOptions` must come before the experimental G1
 * tunables that follow it.
 */
export const AIKAR_FLAGS: readonly string[] = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs',
  '-Daikars.new.flags=true'
]

const RAM_PATTERN = /^[1-9]\d{0,5}[MG]$/

/** A heap size such as `512M` or `8G` (what `-Xms` / `-Xmx` accept). */
export function isValidRam(value: unknown): value is string {
  return typeof value === 'string' && RAM_PATTERN.test(value)
}

/** Heap size in megabytes, e.g. `2G` → 2048. Throws on a malformed value. */
export function ramToMb(value: string): number {
  if (!isValidRam(value)) throw new Error(`Invalid memory size: ${String(value)}`)
  const amount = parseInt(value.slice(0, -1), 10)
  return value.endsWith('G') ? amount * 1024 : amount
}

export interface JvmArgsInput {
  minRam: string
  maxRam: string
  profile?: JvmProfile | null
}

/**
 * Build the JVM arguments (everything before `-jar`) for a server.
 *
 * With the `aikar` profile the initial heap is set equal to the maximum, as
 * the flags require: `AlwaysPreTouch` commits the whole heap at startup and a
 * fixed-size heap avoids resize pauses.
 */
export function buildJvmArgs({ minRam, maxRam, profile }: JvmArgsInput): string[] {
  if (!isValidRam(minRam)) throw new Error(`Invalid minimum memory: ${String(minRam)}`)
  if (!isValidRam(maxRam)) throw new Error(`Invalid maximum memory: ${String(maxRam)}`)
  if (ramToMb(minRam) > ramToMb(maxRam)) {
    throw new Error(`Minimum memory (${minRam}) cannot exceed maximum memory (${maxRam})`)
  }

  if (profile === 'aikar') {
    return [`-Xms${maxRam}`, `-Xmx${maxRam}`, ...AIKAR_FLAGS]
  }
  return [`-Xms${minRam}`, `-Xmx${maxRam}`]
}
