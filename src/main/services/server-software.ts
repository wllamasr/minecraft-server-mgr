import { downloadFile, type DownloadProgress } from '../utils/download'
import { fetchJson } from '../utils/http'
import { verifyFileChecksum } from '../utils/checksum'
import log from '../utils/logger'
import { isReleaseVersion } from '../../shared/utils/minecraft-version'
import {
  PURPUR_API,
  isValidBuildId,
  parseFillBuilds,
  parseFillVersions,
  parsePurpurBuilds,
  parsePurpurVersions,
  resolveFillDownload,
  resolvePurpurDownload,
  type SoftwareBuild,
  type SoftwareDownload
} from '../../shared/utils/server-software'
import type { PluginPlatform } from '../../shared/constants'

/**
 * Downloads of plugin-platform server software (Paper, Purpur, Folia).
 *
 * Unlike mod loaders, these are not installers run on top of the vanilla jar:
 * each build is a complete server jar that replaces `server.jar`.
 */

const FILL_API = 'https://fill.papermc.io/v3/projects'

function assertVersion(mcVersion: string): void {
  if (!isReleaseVersion(mcVersion)) throw new Error(`Invalid Minecraft version: ${mcVersion}`)
}

/** Minecraft versions the platform publishes builds for, newest first. */
export async function getSoftwareVersions(platform: PluginPlatform): Promise<string[]> {
  if (platform === 'purpur') {
    return parsePurpurVersions(await fetchJson(PURPUR_API))
  }
  return parseFillVersions(await fetchJson(`${FILL_API}/${platform}`))
}

/** Builds of the platform for a Minecraft version, newest first. */
export async function getSoftwareBuilds(platform: PluginPlatform, mcVersion: string): Promise<SoftwareBuild[]> {
  assertVersion(mcVersion)
  if (platform === 'purpur') {
    return parsePurpurBuilds(await fetchJson(`${PURPUR_API}/${mcVersion}`))
  }
  return parseFillBuilds(await fetchJson(`${FILL_API}/${platform}/versions/${mcVersion}/builds`))
}

async function resolveDownload(platform: PluginPlatform, mcVersion: string, build: string): Promise<SoftwareDownload> {
  assertVersion(mcVersion)
  if (!isValidBuildId(build)) throw new Error(`Invalid ${platform} build: ${build}`)

  if (platform === 'purpur') {
    const download = resolvePurpurDownload(mcVersion, await fetchJson(`${PURPUR_API}/${mcVersion}/${build}`))
    if (download.build !== build) throw new Error(`Purpur returned build ${download.build} instead of ${build}`)
    return download
  }
  return resolveFillDownload(await fetchJson(`${FILL_API}/${platform}/versions/${mcVersion}/builds`), build)
}

/**
 * Download a platform build to `destPath` and verify it against the checksum
 * the project publishes. Throws (and leaves no file behind) if verification
 * fails.
 */
export async function downloadServerSoftware(
  platform: PluginPlatform,
  mcVersion: string,
  build: string,
  destPath: string,
  onProgress?: (progress: DownloadProgress) => void
): Promise<SoftwareDownload> {
  const download = await resolveDownload(platform, mcVersion, build)
  log.info(`[ServerSoftware] Downloading ${download.fileName} from ${download.url}`)

  await downloadFile(download.url, destPath, onProgress)
  await verifyFileChecksum(destPath, download.checksum.algorithm, download.checksum.value)

  log.info(`[ServerSoftware] Verified ${download.fileName} (${download.checksum.algorithm})`)
  return download
}
