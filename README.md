# linkbed

discord cards with real link buttons. import a url, edit its preview, and share one link.

## local

requires node 24 or newer.

```sh
npm install
npm run dev
```

open http://localhost:3000. local sqlite data stays in `data/`, outside git. `npm run dev` and `npm start` load an optional, git-ignored `.env`; set `DATABASE_URL` and `DATABASE_AUTH_TOKEN` there to connect to your hosted database.

`http://localhost:3000/admin` is the desktop moderation dashboard. it is available only on a loopback-bound local server, never through the public deployment. review reports, manage links and slug bans, ban creator/reporter identities, and revoke masked access tokens. unbanning an identity does not restore revoked tokens.

## deploy

import this repo into vercel, like [pangram badge](https://github.com/schmayterling/pangram-badge). set the chrysalis libsql database url and auth token, then add `linkbed.ryana.dev` and `linkbed.me`. the short domain redirects to `linkbed.ryana.dev`. no framework or build setup. see [deployment instructions](docs/deployment.md).

public terms and privacy pages are at `/terms` and `/privacy`. self-hosters should update their operator/contact details, providers, and retention wording to match their own deployment.

## features

- public webpage metadata import
- visual block editor: markdown, sections, thumbnails, image/video galleries, link rows, separators, Coloris accent picker, searchable emoji picker, and spoilers
- drag grips for blocks, buttons and media; keyboard reorder, themed switches, and independent Discord preview light/dark modes
- CodeMirror json editor with paste/file import, validation and formatting; copy/download discohook message json; block ordering and live discord preview
- sticky actions and mobile tabs; Lucide icons and themed dropdowns
- desktop editor/preview columns; mobile edit/preview tabs
- all supported component types, with discord’s 3,000-byte, 40-component, and 10-gallery-item limits
- server-rendered cards at `/your-slug`; visitors continue to your destination
- publish and edit immediately through a private browser cookie; cards stay live until deleted
- create a one-time access token to keep your existing cards editable and sign in anywhere; save it in a password manager
- edit/delete your cards; choose or rename the custom share address
- copy a discord component-embed script for your own html

## checks

```sh
npm test
npm audit --omit=dev
npm run vendor # refresh checked-in editor, picker and icon assets
```

[discord integration research](docs/discord-embeds.md) includes official docs and discord-userdoccers findings. no discord bot or user token needed.
