import { defineConfig } from 'bunup'

export default defineConfig({
	entry: ['src/index.ts', 'src/main.ts', 'src/server.ts', 'src/vercel.ts'],
	target: 'node',
})
