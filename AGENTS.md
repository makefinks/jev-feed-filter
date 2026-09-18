# Repository Guidelines

## Project Overview

Jev Feed Filter is a Manifest V3 Chrome extension that filters X For You and Following posts and YouTube Home and watch-page video recommendations using the reader's Guidance and a Jev assessment. The reader supplies an API key for one of the supported providers: TypeSafe directly or OpenRouter; there is no developer-operated backend.

## Architecture & Data Flow

- `src/background.ts` is the service worker. It owns persisted settings, credential access, sender validation, assessment requests, caching, concurrency limits, transient warnings, and settings broadcasts.
- `src/feed.ts` is the shared content script. It owns assessment scheduling, caching, stale-result protection, Reveal, and Blur or Collapse presentation.
- `src/sites.ts` owns supported origins and eligible URL paths. `src/sites/` contains the website adapters: surface detection, item selectors, namespaced identities, text extraction, and display-only author labels.
- `src/controls.ts` powers both the popup and options page. It renders public settings, sends typed runtime messages, manages setup and settings views, and keeps filter controls disabled until an API key is configured.
- `src/contracts.ts` is the shared protocol and domain boundary: `Settings`, `Evidence`, `Outcome`, `Message`, the `PROVIDERS` table (name, endpoint, model), the Jev question, and the timeout.

Data flows from controls through `chrome.runtime` messages to the service worker. The service worker persists shared settings in `chrome.storage.local` and sends only text evidence plus Guidance to the selected provider. X evidence contains rendered post text and displayed quotations; YouTube evidence contains only rendered video titles and channel names, including Shorts shelf titles. The feed filters only when the selected provider has a key, nonblank Guidance, and a supported surface are present: X's selected For You or Following feed, YouTube Home (including the Shorts shelf), or watch-page recommendations. Search, subscriptions, video players, descriptions, and comments remain untouched. Guidance, key, and provider changes create a new revision and invalidate pending work; threshold and hide-mode changes reuse existing assessments. Each provider keeps its own stored key, and a switch never falls back to another provider.

## Key Directories

- `src/`: TypeScript extension logic and shared contracts.
- `public/`: Manifest, controls markup/styles, and feed styles copied into the build.
- `scripts/`: Build pipeline.
- `docs/`: Agent-facing issue-tracker and domain-documentation instructions.
- `.scratch/`: Local issue/spec files when feature work is tracked there.
- `dist/`: Generated unpacked-extension output; ignored by Git.

## Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run build`: bundle `src/background.ts`, `src/feed.ts`, and `src/controls.ts` with esbuild and copy public assets into `dist/`.
- `npm run typecheck`: run strict TypeScript checking without emitting files.
- Test, lint, and development-server commands are not currently configured. Load `dist/` as an unpacked extension in Chrome for manual development when explicitly requested.

## Code Conventions & Common Patterns

- Use strict TypeScript, ES modules, and the existing compact formatting/style. Do not introduce a formatter or broad restyling without a specific need.
- Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and `jev-*` for extension-owned DOM classes. DOM handles commonly use an `*El` suffix.
- Validate untrusted runtime messages, persisted storage, sender origins, and provider responses at boundaries. Fail closed: invalid or unavailable assessments leave posts visible and return `{ unavailable: true }` where applicable.
- Catch errors at browser/API boundaries and surface actionable transient warnings through settings state rather than throwing into feed rendering.
- Keep storage writes serialized through the existing promise chain. Use `AbortController` and the shared timeout for provider requests; use revisions/generation checks to discard stale asynchronous results.
- There is no dependency-injection framework. Browser globals, Chrome APIs, storage, runtime messaging, and `fetch` are the module seams; preserve those boundaries when changing behavior.
- Background state separates persisted settings from transient warnings, cache, pending requests, and generation state. Feed state tracks posts and per-visit Reveals. Controls render from validated public `Settings`.

## Important Files

- `public/manifest.json`: Manifest V3 permissions and host grants for X, YouTube, and the provider endpoints, plus the service worker, popup/options page, and content-script registration.
- `src/background.ts`: credential-safe state owner and the provider request boundary.
- `src/feed.ts`: shared assessment lifecycle and presentation modes.
- `src/sites.ts`, `src/sites/`: URL policy and website-specific DOM adapters. Adding a website also requires matching manifest grants and registration; keep unsupported surfaces unfiltered.
- `src/controls.ts`: popup/options UI state and runtime-message handlers.
- `src/contracts.ts`: shared message and settings contracts plus provider constants.
- `public/controls.html`, `public/controls.css`, `public/feed.css`: extension UI and feed presentation assets.
- `scripts/build.mjs`: reproducible bundle-and-copy build.
- `CONTEXT.md`: domain vocabulary and filtering invariants.

## Runtime/Tooling Preferences

- Use Node.js and npm for repository commands; the lockfile is authoritative. `package.json` scripts invoke Node directly.
- Target Chrome 120 or newer, matching `public/manifest.json` and the esbuild target.
- Never place API keys in source, fixtures, or committed files.
- Prefer the existing TypeScript, esbuild, Chrome extension APIs, and DOM primitives over adding framework dependencies.

## Testing & QA

Automated frontend tests are deferred project work. Do not add test files, test dependencies, or test commands unless the user explicitly reopens testing.

Browser or UI verification is also deferred by default. Perform it only when the user explicitly requests it. For non-browser changes, `npm run typecheck` and `npm run build` are the available baseline checks.
