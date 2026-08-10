import { createTestDatabase } from './helpers/db'
import { ensureTestBucket } from './helpers/s3'

// This file is preloaded before all tests run
// It runs once at the start of the test suite

// Silence library logger noise during tests (errors/warns from negative-path
// tests are expected and clutter output). Unset locally to debug.
process.env.PG_HISTORY_SILENT_LOGS = process.env.PG_HISTORY_SILENT_LOGS || '1'

// Set up S3/MinIO environment variables for all tests
// Using default MinIO test configuration
process.env.PG_HISTORY_S3_ENDPOINT =
	process.env.PG_HISTORY_S3_ENDPOINT || 'http://localhost:9000'
process.env.PG_HISTORY_S3_ACCESS_KEY_ID =
	process.env.PG_HISTORY_S3_ACCESS_KEY_ID || 'root'
process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY =
	process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY || 'password'
process.env.PG_HISTORY_S3_REGION =
	process.env.PG_HISTORY_S3_REGION || 'us-east-1'

await createTestDatabase()

// Ensure test bucket exists
await ensureTestBucket('test-bucket')

console.log('✓ Test database created: pg_audit_archiver_test')
console.log(`✓ S3/MinIO configured: ${process.env.PG_HISTORY_S3_ENDPOINT}`)
console.log('✓ Test bucket ensured: test-bucket')
