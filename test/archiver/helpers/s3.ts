import {
	CreateBucketCommand,
	HeadBucketCommand,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'

/**
 * Ensure a test bucket exists, creating it if necessary
 */
export async function ensureTestBucket(bucketName: string): Promise<void> {
	const endpoint = process.env.PGHISTORY_S3_ENDPOINT || 'http://localhost:9000'
	const accessKeyId = process.env.PGHISTORY_S3_ACCESS_KEY_ID || 'root'
	const secretAccessKey =
		process.env.PGHISTORY_S3_SECRET_ACCESS_KEY || 'password'
	const region = process.env.PGHISTORY_S3_REGION || 'us-east-1'

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
 * Upload a dummy object to S3 so that verifyS3File finds it during tests.
 */
export async function putTestS3Object(
	bucketName: string,
	key: string,
): Promise<void> {
	const client = new S3Client({
		endpoint: process.env.PGHISTORY_S3_ENDPOINT || 'http://localhost:9000',
		region: process.env.PGHISTORY_S3_REGION || 'us-east-1',
		credentials: {
			accessKeyId: process.env.PGHISTORY_S3_ACCESS_KEY_ID || 'root',
			secretAccessKey: process.env.PGHISTORY_S3_SECRET_ACCESS_KEY || 'password',
		},
		forcePathStyle: true,
	})
	await client.send(
		new PutObjectCommand({
			Bucket: bucketName,
			Key: key,
			Body: Buffer.from('test-data'),
		}),
	)
}

/**
 * Check if S3/MinIO is properly configured and accessible
 */
export async function isS3Configured(): Promise<boolean> {
	// First check if env vars are set
	if (
		!process.env.PGHISTORY_S3_ENDPOINT ||
		!process.env.PGHISTORY_S3_ACCESS_KEY_ID ||
		!process.env.PGHISTORY_S3_SECRET_ACCESS_KEY
	) {
		return false
	}

	// Then verify we can actually connect and perform operations
	const client = new S3Client({
		endpoint: process.env.PGHISTORY_S3_ENDPOINT,
		region: process.env.PGHISTORY_S3_REGION || 'us-east-1',
		credentials: {
			accessKeyId: process.env.PGHISTORY_S3_ACCESS_KEY_ID,
			secretAccessKey: process.env.PGHISTORY_S3_SECRET_ACCESS_KEY,
		},
		forcePathStyle: true,
	})

	try {
		// Try to ensure bucket exists - this will create it or verify access
		await ensureTestBucket('test-bucket')

		// Also try a head operation to make sure we can actually read
		await client.send(new HeadBucketCommand({ Bucket: 'test-bucket' }))
		return true
	} catch (error) {
		console.log(
			'⚠️  S3 connectivity check failed:',
			error instanceof Error ? error.message : String(error),
		)
		return false
	}
}
