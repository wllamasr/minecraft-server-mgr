import { readFileSync, writeFileSync } from 'fs'

export interface ServerProperties {
  [key: string]: string
}

export function readProperties(filePath: string): ServerProperties {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const properties: ServerProperties = {}

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const separatorIdx = trimmed.indexOf('=')
    if (separatorIdx === -1) continue

    const key = trimmed.slice(0, separatorIdx).trim()
    const value = trimmed.slice(separatorIdx + 1).trim()
    properties[key] = value
  }

  return properties
}

export function saveProperties(filePath: string, properties: ServerProperties): void {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')
  const newLines: string[] = []
  
  const writtenKeys = new Set<string>()

  // Replace existing keys while preserving comments
  for (const line of lines) {
    const trimmed = line.trim()
    
    // Pass comments and empty lines through
    if (!trimmed || trimmed.startsWith('#')) {
      newLines.push(line)
      continue
    }

    const separatorIdx = trimmed.indexOf('=')
    // Malformed line pass through
    if (separatorIdx === -1) {
      newLines.push(line)
      continue
    }

    const key = trimmed.slice(0, separatorIdx).trim()
    if (key in properties) {
      newLines.push(`${key}=${properties[key]}`)
      writtenKeys.add(key)
    } else {
      newLines.push(line)
    }
  }

  // Add any new keys that weren't in the original file
  for (const [key, value] of Object.entries(properties)) {
    if (!writtenKeys.has(key)) {
      newLines.push(`${key}=${value}`)
    }
  }

  writeFileSync(filePath, newLines.join('\n'))
}
