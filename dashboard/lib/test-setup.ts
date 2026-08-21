import { mock } from 'bun:test'

/**
 * `server-only` exists to make importing a module from a Client Component a
 * build error, and it does that by resolving to a module that throws under any
 * condition Next does not set. `bun test` is one of those, so a unit test of a
 * server module cannot import it at all.
 *
 * Stubbing the package restores testability without weakening the guard: the
 * marker still does its job in the Next build, which is the only place it was
 * ever meant to run.
 */
mock.module('server-only', () => ({}))
