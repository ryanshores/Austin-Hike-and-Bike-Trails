# Repository Guidelines

## Development workflow

- Start every feature from an up-to-date `main` branch.
- Use one short-lived branch per feature or fix. Keep unrelated work in separate
  branches and pull requests.
- Prefer branch names such as `codex/trail-search` or
  `codex/gps-diagnostics`.
- Open a pull request into `main`; do not push feature work directly to `main`.
- Keep pull requests small enough to review as one coherent behavior change.
- Use the private staging site only for persistent integration testing.
  Pull-request previews, when enabled through Cloudflare Workers, are the
  preferred environment for isolated feature testing.

## Verification

- Run `npm run lint` and `npm test` before requesting review.
- Add or update tests for behavior changes, especially GPS-quality decisions,
  route rendering, and server-rendered page content.
- Treat browser geolocation as device-provided data. Never display a coarse or
  stale fix as if it were precise.
- Preserve viewport-bounded, paginated ArcGIS bicycle-facility queries.

## Code Review Rules

- Flag changes that recenter Ride Mode on coarse, stale, or implausible
  location fixes. The safe behavior is to wait for a usable first fix and retain
  the last trustworthy position when signal quality deteriorates.
- Flag unbounded or unpaginated ArcGIS bicycle-facility requests. Queries must
  remain scoped to the visible map and handle the service record limit.
- Flag any deployment change that can publish a feature branch to the public
  production site. Feature branches may create preview versions; production
  deployment must remain an explicit post-merge action.
