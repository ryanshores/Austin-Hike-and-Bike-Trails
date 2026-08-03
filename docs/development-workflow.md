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

The `Codex Review Gate` workflow waits for Codex to review the pull request's
current commit. It accepts either a submitted Codex review or Codex's thumbs-up
reaction when there are no findings. Draft pull requests do not run the gate;
marking one ready starts both automatic review and the gate. Pushing another
commit requires a fresh review of that commit.

## Pull-request previews

Cloudflare Workers provides the deployment path for both isolated pull-request
previews and production. Configure the GitHub integration with:

- Production branch: `main`
- Build command: `npm ci && npm run build`
- Production deploy command: disabled until an explicit release from `main`
  is authorized
- Non-production deploy command: `npx wrangler versions upload`
- Preview URLs: enabled, with Cloudflare Access when previews must be private

Cloudflare posts a commit-specific and branch-stable preview URL on each pull
request. Runtime configuration is committed in `wrangler.jsonc`; secrets stay
in Cloudflare. Use `keep_vars: true` until dashboard-managed provider values
have been migrated into a deliberate configuration-management workflow.
