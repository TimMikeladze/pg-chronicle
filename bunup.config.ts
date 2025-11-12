import { defineConfig } from 'bunup'

export default defineConfig({
	entry: ['src/index.ts', 'src/archiver/cli.ts'],
	target: 'bun',
})
