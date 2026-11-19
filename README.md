# chat-demo

English | [简体中文](README.zh-CN.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

You can [try the app online](https://deepseek-ai.github.io/chat-demo/) or download the archive from [Releases](https://github.com/deepseek-ai/deepseek-chat-demo/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Enter your API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/deepseek-ai/chat-demo.git
cd chat-demo
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Cross-device sync

Settings → Data → Cross-device sync can sync conversations and original images to your own private GitHub repository without an application backend. The settings page walks through three steps ([create a private repository](https://github.com/new?name=chat-demo-data&visibility=private), [create a token](https://github.com/settings/personal-access-tokens/new), paste and validate), and the repository field accepts a full GitHub URL. Enter `owner/repo`, a branch, and a fine-grained PAT limited to that repository with `Contents: Read and write`, then sync manually or enable auto sync to pull when the page becomes visible and push after replies finish.

Validate connection checks the token permissions, whether the branch exists, and whether the repository is public. A public repository triggers a warning that anyone who can access it can read conversations and images. Tokens nearing expiry are flagged, and expired tokens stop automatic sync.

Sync stores a Git tree snapshot: `manifest.json`, one `sessions/{id}.json` per conversation, content-addressed `files/{sha256}`, and deletion markers under `tombstones/`. Both sides are merged by session and message id; titles and branch selections use the newer timestamp. Conflicting branch selections never drop messages—the other branch stays available through the existing version switcher. If another device clears all chats, this device asks whether to follow the reset.

Repository contents are plaintext: anyone who can read the repository can see conversations and images. The token stays in local localStorage and is never uploaded. Settings, the API key, unsent drafts, and original non-image attachments are not synced.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm test`   | Run unit tests               |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
