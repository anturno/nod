/** Fixed bounds of the MCP client. Context byte limits live in src/core/context/limits.ts. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
export const MAX_EXPANDED_BYTES = 1024 * 1024;
export const MAX_LIST_PAGES = 64;
export const MAX_CURSOR_BYTES = 4096;
export const MAX_SCHEMA_DEPTH = 64;
export const MAX_SSE_EVENTS = 1024;
export const MAX_SEARCH_MATCHES = 20;
export const STDERR_RING_LINES = 64;
export const MAX_SCOPE_RETRIES = 2;
export const REFRESH_EARLY_MS = 60_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;
export const DEFAULT_RESTART_LIMIT = 1;
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LEGACY_SSE_VERSION = "2024-11-05";
