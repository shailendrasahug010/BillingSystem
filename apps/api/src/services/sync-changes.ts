/**
 * How long the pull feed's change log (sync_changes) is kept. The nightly job
 * deletes older rows; a device that last pulled before then loads the whole
 * business again instead (GET /sync/pull answers `reset`).
 */
export const SYNC_KEEP_DAYS = 30;
