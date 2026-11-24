/** The domain this worker screens. It names the one Screener, and forwarding mail to it would loop back here. */
export const SCREENED_DOMAIN = "bachman.dev";

/** The longest subject a review keeps. */
export const MAX_SUBJECT_LENGTH = 200;

export const DAY_MS = 86_400_000;

/** How many days a review stays open without a decision before it's dismissed. */
export const REVIEW_EXPIRY_DAYS = 14;

export const REVIEW_EXPIRY_MS = REVIEW_EXPIRY_DAYS * DAY_MS;

/** How many closed cards go in one queue batch; `sendBatch()` takes up to 100 messages and 256 KB. */
export const EXPIRY_BATCH_SIZE = 50;
