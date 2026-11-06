import type { MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'

/**
 * Rejects request bodies over `maxSize` bytes with a `413`.
 *
 * Same contract as `hono/body-limit`, with one difference. A body without a
 * `content-length` (chunked, or the empty stream Next.js 16 attaches to every
 * request, OPTIONS included) has to be read to be measured, and Hono then
 * rebuilds the request with `new Request(c.req.raw, init)`. Node's undici
 * rejects the request object Next.js hands a route handler, so every such
 * request failed with `500 Failed to parse URL from [object Request]`. This
 * rebuilds it from the URL instead.
 */
export function limitBody(maxSize: number): MiddlewareHandler {
	const tooLarge = (): never => {
		throw new HTTPException(413, {
			res: new Response('Payload Too Large', { status: 413 }),
		})
	}

	return async (c, next) => {
		const raw = c.req.raw
		if (!raw.body) return next()

		if (
			raw.headers.has('content-length') &&
			!raw.headers.has('transfer-encoding')
		) {
			const declared = Number.parseInt(
				raw.headers.get('content-length') || '0',
				10,
			)
			return declared > maxSize ? tooLarge() : next()
		}

		const chunks: Uint8Array[] = []
		let size = 0
		const reader = raw.body.getReader()
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			size += value.byteLength
			if (size > maxSize) {
				await reader.cancel().catch(() => {})
				return tooLarge()
			}
			chunks.push(value)
		}

		const body = new Uint8Array(size)
		let offset = 0
		for (const chunk of chunks) {
			body.set(chunk, offset)
			offset += chunk.byteLength
		}

		// GET and HEAD cannot carry a body in a constructed Request.
		const bodiless = raw.method === 'GET' || raw.method === 'HEAD'
		c.req.raw = new Request(raw.url, {
			method: raw.method,
			headers: raw.headers,
			body: bodiless || size === 0 ? undefined : body,
			signal: raw.signal,
		})
		return next()
	}
}
