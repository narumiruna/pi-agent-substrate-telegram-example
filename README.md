# TypeScript Template

## Human workflow

Install dependencies, build, and run:

```sh
npm install
npm run build
npm start
```

## Automation

```sh
npm run ci
```

The CI command runs Biome, Vitest, and the TypeScript build. Husky runs it before each commit.

## Release workflow

In `narumiruna/typescript-template`, the workflow starts, but the release job is skipped. Projects created from this template run the job without changes to the workflow condition. Before publishing, update the package name and repository URL in `package.json`.

Create and commit a changeset with each releasable change:

```sh
npm run changeset
```

When changesets reach `main`, [`.github/workflows/release.yml`](.github/workflows/release.yml) opens or updates a version pull request. Merging that pull request publishes the package, creates its Git tag, and creates a GitHub release.

Publishing uses npm trusted publishing. Configure the npm package's trusted publisher with this GitHub repository and the `release.yml` workflow. Also allow GitHub Actions to create pull requests in the repository's Actions settings.
