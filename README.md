# Austin Hike & Bike Atlas

A responsive Austin trail atlas with a desktop planning map and a dedicated
full-screen ride experience.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm install
npm run dev
npm run build
```

This starter does not use `wrangler.jsonc`.

## Release targets

This repository uses two branches and two independent Sites projects:

- `main` targets the public production site.
- `staging` targets the private staging site.

Project IDs are stored only in the repository's local Git configuration. They
are not committed. The configured checkout hook generates the ignored
`.openai/hosting.json` file whenever branches change.

Before publishing, commit the intended code and run:

```bash
npm test
sh scripts/prepare-site-deployment.sh
```

## Contributing

Use one short-lived branch and one pull request per feature. Pull requests run
lint, build, and test checks and are reviewed using the rules in `AGENTS.md`.
See [Development and Review Workflow](docs/development-workflow.md) for branch,
review, staging, and pull-request preview details.

## Useful Commands

- `npm run dev`: start local development
- `npm test`: build the app and run the route and GPS policy tests
- `npm run db:generate`: generate Drizzle migrations after schema changes
