// Entry point for `npm run vendor`. esbuild bundles the Anthropic SDK
// from node_modules into vendor/anthropic-sdk.js, which scribe.js
// imports directly. The extension has no build step of its own, and
// Manifest V3 forbids loading code from a CDN, so the SDK ships as a
// checked-in file. Re-run `npm run vendor` after bumping the version.
export { default } from '@anthropic-ai/sdk';
