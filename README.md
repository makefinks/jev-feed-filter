# Jev Feed Filter
https://github.com/user-attachments/assets/8faee26b-6bc4-4f80-a820-e11cedfeb643


A Chrome extension that hides posts that you are not interested in.

Under the hood it uses TypeSafe's new [Jev model](https://typesafe.ai/blog/introducing-system-one-models-and-jev) to assess post relevance according to written guidance you provide.

It currently supports filtering for X and YouTube feeds (with more hopefully coming soon).

## How it works

1. You describe what you want to avoid or see via free-text input in the extension modal.
2. Each post in your feed is checked against your guidance, and the Jev model assigns it a filter probability.
3. Posts rated above your threshold (default 60%) are blurred or collapsed. You can still reveal them to evaluate if the filter worked as expected.

## Install

Requires Chrome 120 or newer, plus an API key from TypeSafe or OpenRouter.

1. Download `jev-feed-filter.zip` from the latest [release](https://github.com/makefinks/jev-feed-filter/releases/latest) ([direct download](https://github.com/makefinks/jev-feed-filter/releases/latest/download/jev-feed-filter.zip)) and unzip it.
2. Open `chrome://extensions`, enable Developer mode (top right), and load the unzipped folder with `Load unpacked` (top left).
3. Open the extension popup (pin the extension while you're at it), go to Settings, and save your API key.
4. Back on the main view set your guidance text for filtering — the filter is applied automatically.

## Development

1. Run `npm install`, then `npm run build` (`npm run package` for a release zip).
2. Open `chrome://extensions`, enable Developer mode, and load `dist/` with Load unpacked.

## Privacy

Keys and settings are stored locally. There is no developer backend. Feed content is processed by the selected API provider.

## Scripts

* `npm run build`: bundle `src/` with esbuild and copy `public/` assets to `dist/`.
* `npm run package`: build plus a release-ready `jev-feed-filter.zip`.
* `npm run release -- <patch|minor|major>`: bump version, tag, and push (triggers the GitHub release).
