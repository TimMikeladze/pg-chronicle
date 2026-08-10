import type { ErrorResponse } from './types'

export function createErrorResponse(
	code: string,
	message: string,
	details?: unknown,
): ErrorResponse {
	return {
		error: {
			code,
			message,
			details,
		},
	}
}
