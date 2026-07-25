# Development and Review Workflow

## One feature, one branch, one pull request

Create each feature from the latest `main`:

```bash
git switch main
git pull --ff-only
git switch -c codex/short-feature-name
```

Keep the branch limited to one coherent outcome. Run `npm run lint` and
`npm test`, push the branch, and open a pull request into `main`. CI and Codex
review the pull request; production publishing happens only after merge and a
deliberate release.

The long-lived `staging` branch is reserved for testing combinations of changes
when an isolated PR preview is insufficient. It is not the default base for
feature work.

## Codex review

Codex Cloud must be connected to this GitHub repository. Enable **Code review**
and **Automatic reviews** in Codex settings. The root `AGENTS.md` supplies
repository-specific review rules. A manual review can be requested by
commenting `@codex review` on a pull request.

## Pull-request previews

ChatGPT Sites versions are releases for a selected Sites project; they are not
GitHub pull-request preview environments. Keep the current private Sites
staging project for stable integration tests.

For isolated PR previews, connect this GitHub repository to a Cloudflare Worker
and configure:

- Production branch: `main`
- Build command: `npm ci && npm run build`
- Production deploy command: disabled until an explicit release workflow is
  adopted
- Non-production deploy command: `npx wrangler versions upload`
- Preview URLs: enabled, with Cloudflare Access when previews must be private

Cloudflare then posts a commit-specific and branch-stable preview URL on each
pull request. This requires a Cloudflare account connection and cannot reuse
the hidden infrastructure credentials owned by ChatGPT Sites.
