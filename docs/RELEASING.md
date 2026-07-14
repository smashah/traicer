# Release workflow

Traicer releases the CLI first. Bumpy publishes `@traice/traicer` to npm, writes its changelog, creates the `@traice/traicer@<version>` tag, and publishes the matching GitHub release. That published release starts the lower-priority desktop workflow, which builds and attaches signed DMG, EXE/MSI, AppImage, and DEB artifacts without republishing the CLI.

## Preparing a change

Every user-visible or package-affecting pull request needs a Bumpy file under `.bumpy/`:

```sh
pnpm exec bumpy add
pnpm release:status
pnpm release:check
```

Choose `patch`, `minor`, or `major` for each affected package and write the summary for users, not maintainers. `@traice/traicer` and the private `@traice/desktop` package are a fixed group, so their versions remain aligned. Bumpy's GitHub changelog generator combines the bump summaries with pull-request and contributor metadata; do not hand-edit package changelogs during normal releases.

The `release metadata` action runs `bumpy ci check` on pull requests. It reports the release plan and flags package changes that do not have a bump file.

## Automated release sequence

1. **Plan on `main`.** `.github/workflows/release.yml` runs `bumpy ci plan`. Pending bump files select `version-pr`; versioned packages that are not on npm select `publish`; otherwise the workflow stops.
2. **Merge the version PR.** Bumpy opens or updates `bumpy/version-packages`, consumes the bump files, updates both package versions, and generates `apps/cli/CHANGELOG.md`. Review the generated versions and changelog, then merge it normally.
3. **Publish the CLI.** The next `main` run tests, typechecks, and builds `@traice/traicer`, requires `LICENSE`, publishes through npm trusted publishing with provenance, pushes the package tag, and creates the GitHub release.
4. **Attach desktop installers.** The published package release starts `.github/workflows/desktop-release.yml`. Its matrix builds signed installers, checksums, SBOMs, provenance attestations, and the signed updater manifest, then uploads them to the existing CLI release. A failed desktop run can be retried with `workflow_dispatch` and the existing package tag; npm is not touched.

The release tag is Bumpy's package tag, for example `@traice/traicer@0.1.0`. Do not create `v0.1.0` tags or hand-create a second GitHub release.

## One-time repository and registry setup

- Select the distribution licence and commit `LICENSE`. Publication deliberately fails without it because this repository currently grants no redistribution rights.
- Create or verify the public npm package `@traice/traicer` under the `@traice` scope. Configure npm trusted publishing for repository `smashah/traicer`, workflow `release.yml`, and GitHub environment `publish`. The first publish cannot use npm staged publishing.
- Create protected GitHub environments named `publish` and `release`. Require approval for `release` if desktop signing should remain a separate operator decision.
- Add `BUMPY_GH_TOKEN` as a repository Actions secret using a fine-grained bot PAT or GitHub App token with repository contents and pull-request write access. Bumpy uses it to make version-PR and release events trigger downstream workflows; releases created with the default `GITHUB_TOKEN` do not trigger the desktop workflow.
- Add the Apple certificate, notarisation, Windows/Tauri signing, and updater secrets referenced by `desktop-release.yml` to the `release` environment. Keep all private signing material in environment secrets, never repository variables or files.

## Local inspection

These commands inspect the release without changing package versions or publishing anything:

```sh
pnpm install
pnpm release:status
pnpm --filter @traice/traicer test
pnpm --filter @traice/traicer typecheck
pnpm --filter @traice/traicer build
cd apps/cli && npm pack --dry-run
```

`bumpy version` and `bumpy publish` are intentionally omitted from the routine local flow. The protected GitHub workflow owns version commits, npm provenance, tags, and GitHub releases so those artifacts all refer to the same reviewed commit.
