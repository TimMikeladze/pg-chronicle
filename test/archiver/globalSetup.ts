import { createTestDatabase } from './helpers/db'

// This file is preloaded before all tests run
// It runs once at the start of the test suite
await createTestDatabase()

console.log('✓ Test database created: pg_audit_archiver_test')
