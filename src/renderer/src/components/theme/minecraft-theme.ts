import { createTheme, virtualColor } from '@mantine/core'

export const minecraftTheme = createTheme({
  primaryColor: 'emerald',
  primaryShade: 4,
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  fontFamilyMonospace: '"JetBrains Mono", "Fira Code", monospace',
  headings: {
    fontFamily: 'Inter, system-ui, sans-serif',
    fontWeight: '700'
  },
  defaultRadius: 'md',
  colors: {
    // Command Core Emerald Palette
    emerald: [
      '#D7FFE0', // 0
      '#AFFFC3', // 1
      '#86FEA4', // 2
      '#5DFA86', // 3
      '#54E98A', // 4: Primary
      '#3DE07A', // 5
      '#2ECC71', // 6: Primary-container
      '#24B760', // 7
      '#1A924F', // 8
      '#106D3E'  // 9
    ],
    // Obsidian Dark Hierarchy (Mantine uses 0 light -> 9 dark)
    dark: [
      '#E5E2E1', // 0: on-surface (Text)
      '#BBCBBB', // 1: on-surface-variant (Labels)
      '#A9A9A9', // 2
      '#3D4A3E', // 3: outline-variant (Ghost Border)
      '#2A2A2A', // 4: container-high
      '#201F1F', // 5: container
      '#1C1B1B', // 6: container-low
      '#131313', // 7: surface (Base)
      '#0E0E0E', // 8: container-lowest
      '#050505'  // 9
    ]
  },
  components: {
    Button: {
      defaultProps: {
        radius: 'md'
      },
      styles: () => ({
        root: {
          transition: 'transform 100ms ease, box-shadow 100ms ease'
        }
      })
    },
    Card: {
      defaultProps: {
        bg: 'dark.5',
        withBorder: false // Standardized No-Line rule
      }
    },
    Paper: {
      defaultProps: {
        bg: 'dark.6',
        withBorder: false
      }
    }
  }
})
