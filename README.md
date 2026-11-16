# lembed

self-hosted discord card builder inspired by tinycord.

## local

requires node 24 or newer.

```sh
npm install
npm run dev
```

open http://localhost:3000. sqlite data stays in `data/`, outside git.

## planned first version

- import public webpage metadata
- edit title, description, images, accent, and five link buttons
- publish server-rendered pages at `/p/your-slug`
- keep edit access in a secure browser cookie
- copy a standalone discord component-embed script

## discord integration

see [docs/discord-embeds.md](docs/discord-embeds.md). no discord bot or user token is required.
