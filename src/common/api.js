/* Tiny shim so the same code runs under `browser.*` (Firefox) and `chrome.*`. */
globalThis.patternCopyApi = globalThis.browser || globalThis.chrome;
