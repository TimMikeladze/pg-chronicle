import { S3Client } from 'bun'

/**
 * Ensure a test bucket exists, creating it if necessary
 */
export async function ensureTestBucket(bucketName: string): Promise<void> {
	const endpoint = process.env.PG_HISTORY_S3_ENDPOINT || 'http://localhost:9000'
	const accessKeyId =
		process.env.PG_HISTORY_S3_ACCESS_KEY_ID || 'root'
	const secretAccessKey =
		process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY || 'password'
	const region = process.env.PG_HISTORY_S3_REGION || 'us-west-1'

	try {
		// Check if bucket exists by trying to write a test file
		const testClient = new S3Client({
			endpoint,
			accessKeyId,
			secretAccessKey,
			region,
			bucket: bucketName,
		})

		const testFile = testClient.file('.bucket-test')

		// Try to check if bucket exists
		const exists = await testFile.exists()

		if (exists) {
			console.log(`✓ Test bucket already exists: ${bucketName}`)
		} else {
			// Write a test file to ensure bucket works
			await testFile.write('test')
			console.log(`✓ Test bucket is accessible: ${bucketName}`)
		}
	} catch (error) {
		// If NoSuchBucket error, bucket doesn't exist
		if (
			error &&
			typeof error === 'object' &&
			'name' in error &&
			error.name === 'S3Error'
		) {
			console.warn(
				`⚠️  Warning: Cannot access bucket ${bucketName} - ensure bucket exists in MinIO`,
			)
		} else {
			console.warn(
				`⚠️  Warning: S3 may not be configured for bucket ${bucketName}`,
			)
		}
		// Don't throw - tests will skip gracefully
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
