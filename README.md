# lembed

discord cards with real link buttons. import a url, edit its preview, and share one link.

## local

requires node 24 or newer.

```sh
npm install
npm run dev
```

open http://localhost:3000. local sqlite data stays in `data/`, outside git.

## deploy

import this repo into vercel, like [pangram badge](https://github.com/schmayterling/pangram-badge). set the chrysalis libsql database url and auth token, then add `lembed.ryana.dev`. no framework or build setup. see [deployment instructions](docs/deployment.md).

## features

- public webpage metadata import
- title, description, images, accent, and five link buttons
- server-rendered cards at `/p/your-slug`
- one-time sign-in token; save it in a password manager and sign in anywhere
- edit/delete your cards from any signed-in device
- copy a discord component-embed script for your own html

## checks

```sh
npm test
npm audit --omit=dev
```

[discord integration research](docs/discord-embeds.md) includes official docs and discord-userdoccers findings. no discord bot or user token needed.
