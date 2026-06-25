# X Collect — Local Test Extension (disposable)

A **zero-build, standalone** unpacked extension to validate the X collection
mechanism (background tab + `document_start` MAIN-world interceptor) in a real
browser, with **no backend, no server API, and no build step**.

## Load

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this
   `local-xtest/` folder.
2. Log into x.com in the same Chrome profile (your collection account).
3. Extension → Details → **Extension options** → use the two test panels.

## ⚠️ This is a throwaway debug tool

The vanilla JS here (`x-capture.js`, `background.js`'s `parseTweetResult` /
tab-session logic) is a **hand-maintained mirror** of the TypeScript source under
`../src/`:

| local-xtest (vanilla)        | src (TypeScript)                         |
| ---------------------------- | ---------------------------------------- |
| `x-capture.js`               | `src/pages/content/x-capture.ts`         |
| `background.js` (tab session)| `src/utils/executor/x.tab-reader.ts`     |
| `background.js` (parsing)    | `src/utils/executor/x.parse.ts` + `x.debug.ts` |

They can DRIFT. Treat this folder as disposable: it exists only to verify the
mechanism. The TypeScript versions are the source of truth for the real build.
