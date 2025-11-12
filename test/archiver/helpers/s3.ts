import {
	CreateBucketCommand,
	HeadBucketCommand,
	S3Client,
} from '@aws-sdk/client-s3'

/**
 * Ensure a test bucket exists, creating it if necessary
 */
export async function ensureTestBucket(bucketName: string): Promise<void> {
	const s3Client = new S3Client({
		endpoint: process.env.S3_ENDPOINT,
		region: process.env.S3_REGION || 'us-east-1',
		credentials: {
			accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
			secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
		},
		forcePathStyle: true, // Required for MinIO
	})

	try {
		// Check if bucket exists
		await s3Client.send(new HeadBucketCommand({ Bucket: bucketName }))
	} catch (error) {
		// Bucket doesn't exist or we don't have permission to check, try to create it
		if (error && typeof error === 'object' && 'name' in error) {
			const errorName = error.name
			const errorCode =
				'$metadata' in error && error.$metadata
					? (error.$metadata as { httpStatusCode?: number }).httpStatusCode
					: undefined

			if (
				errorName === 'NotFound' ||
				errorName === 'NoSuchBucket' ||
				errorCode === 403 ||
				errorCode === 404
			) {
				try {
					await s3Client.send(new CreateBucketCommand({ Bucket: bucketName }))
					console.log(`✓ Created test bucket: ${bucketName}`)
				} catch (createError) {
					// If bucket already exists, that's fine
					if (
						createError &&
						typeof createError === 'object' &&
						'name' in createError &&
						(createError.name === 'BucketAlreadyExists' ||
							createError.name === 'BucketAlreadyOwnedByYou')
					) {
						console.log(`✓ Test bucket already exists: ${bucketName}`)
					} else if (
						createError &&
						typeof createError === 'object' &&
						'name' in createError &&
						createError.name === 'InvalidAccessKeyId'
					) {
						// Invalid credentials - S3 is not properly configured for tests
						console.warn(
							`⚠️  Warning: Cannot create bucket ${bucketName} - Invalid S3 credentials`,
						)
						// Don't throw - tests will skip gracefully with ERR_S3_MISSING_CREDENTIALS or NoSuchBucket
					} else {
						console.error(`Failed to create bucket ${bucketName}:`, createError)
						throw createError
					}
				}
			} else {
				// Some other error (like invalid credentials)
				throw error
			}
		} else {
			throw error
		}
	} finally {
		s3Client.destroy()
	}
}

/**
 * Check if S3/MinIO is properly configured
 */
export function isS3Configured(): boolean {
	return !!(
		process.env.S3_ENDPOINT &&
		process.env.S3_ACCESS_KEY_ID &&
		process.env.S3_SECRET_ACCESS_KEY
	)
}
