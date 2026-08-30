// Barrel for the session poller's public surface. server.mjs and the tests
// import from here; the implementation is split by concern:
//
//   claude-state.mjs - reads Claude Code's internal files and knows their shape;
//                      the whole blast radius of an upstream format change
//   card-copy.mjs    - pure text: phrasing, truncation, time formatting; no I/O
//   poller.mjs       - the poll loop and card lifecycle
//
// Keep this export list stable: it is the seam that lets server.mjs and the
// modules behind it be refactored independently.

export {
  SESSIONS_DIR, PROJECTS_DIR, TRANSCRIPT_HEAD_BYTES,
  pidAlive, transcriptPathFor, transcriptTitle, titleFor,
  currentActivity, lastQuestion, inferredStatus, withInferredStatus,
  pendingWakeup, withPendingWakeup, WAKE_GRACE_MS,
} from './claude-state.mjs'
export {
  TITLE_LIMIT,
  laneFor, lineFor, pathLabel, titleTrim,
  readablePattern, defaultPhrase, toolPhrase,
  stripMd, fmtMins, activityBody,
} from './card-copy.mjs'
export { DEFAULTS, WAITING_FRESH_MS, qualifies, selectCards, startSessionPoller } from './poller.mjs'
