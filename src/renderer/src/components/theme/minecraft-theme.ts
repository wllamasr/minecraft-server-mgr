import { createTheme } from '@mantine/core'

export const minecraftTheme = createTheme({
  primaryColor: 'green',
  fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
  fontFamilyMonospace: 'JetBrains Mono, Fira Code, Consolas, monospace',
  headings: {
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    fontWeight: '700'
  },
  defaultRadius: 'md',
  colors: {
    // Custom Minecraft-inspired green palette
    green: [
      '#e5fbef',
      '#d0f4df',
      '#a3e8bd',
      '#72dc98',
      '#4bd179',
      '#34ca65',
      '#25c759',
      '#16af49',
      '#049c3e',
      '#00872f'
    ],
    // Deep dark backgrounds
    dark: [
      '#C1C2C5',
      '#A6A7AB',
      '#909296',
      '#5c5f66',
      '#373A40',
      '#2C2E33',
      '#25262b',
      '#1A1B1E',
      '#141517',
      '#101113'
    ]
  },
  other: {
    // Minecraft-inspired accents
    endermanPurple: '#8b5cf6',
    netherRed: '#ef4444',
    diamondBlue: '#06b6d4',
    goldYellow: '#f59e0b'
  }
})
