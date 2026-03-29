import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/main/database/schema.ts',
  out: './src/main/database/drizzle',
  dialect: 'sqlite'
})
