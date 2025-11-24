import {
	CreateBucketCommand,
	HeadBucketCommand,
	S3Client,
} from '@aws-sdk/client-s3'

/**
 * Ensure a test bucket exists, creating it if necessary
 */
export async function ensureTestBucket(bucketName: string): Promise<void> {
	const endpoint = process.env.PG_HISTORY_S3_ENDPOINT || 'http://localhost:9000'
	const accessKeyId = process.env.PG_HISTORY_S3_ACCESS_KEY_ID || 'root'
	const secretAccessKey =
		process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY || 'password'
	const region = process.env.PG_HISTORY_S3_REGION || 'us-east-1'

	const client = new S3Client({
		endpoint,
		region,
		credentials: {
			accessKeyId,
			secretAccessKey,
		},
		forcePathStyle: true, // Required for MinIO
	})

	try {
		// Check if bucket exists
		await client.send(new HeadBucketCommand({ Bucket: bucketName }))
		console.log(`✓ Test bucket already exists: ${bucketName}`)
	} catch (error) {
		// If bucket doesn't exist, create it
		if (
			error &&
			typeof error === 'object' &&
			'name' in error &&
			(error.name === 'NoSuchBucket' || error.name === 'NotFound')
		) {
			try {
				await client.send(new CreateBucketCommand({ Bucket: bucketName }))
				console.log(`✓ Created test bucket: ${bucketName}`)
			} catch (createError) {
				console.warn(
					`⚠️  Warning: Cannot create bucket ${bucketName}:`,
					createError instanceof Error
						? createError.message
						: String(createError),
				)
			}
		} else {
			console.warn(
				`⚠️  Warning: S3 error for bucket ${bucketName}:`,
				error instanceof Error ? error.message : String(error),
			)
		}
	}
}

/**
 * Check if S3/MinIO is properly configured
 */
export function isS3Configured(): boolean {
	return !!(
		process.env.PG_HISTORY_S3_ENDPOINT &&
		process.env.PG_HISTORY_S3_ACCESS_KEY_ID &&
		process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY
	)
}
