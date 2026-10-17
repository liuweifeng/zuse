# Zuse documentation

The documentation site is a Next.js application in the repository's Bun
workspace.

## Content boundary

Only `content/docs` is published, through the collection in `source.config.ts`.
Search, sitemap, and LLM exports all use that same collection.
Repository operator runbooks belong in `internal-docs/`, not this collection.
Do not copy or import internal runbooks into public pages. This README is for
docs-site maintainers and is not part of the published collection.

## Local development

Install dependencies once from the repository root:

```bash
bun install --frozen-lockfile
```

Then start the docs app:

```bash
bun run --cwd apps/docs dev
```

The local site is available at `http://localhost:3002`.

## Navigation and pages

- Sections (the sidebar switcher) are assembled in `src/lib/source.ts`. Each
  content folder becomes a labeled group; its `meta.json` `title` is the group
  label and `pages` sets the order.
- Every page sets an `icon` (a Lucide name, or `logo:<name>` for a provider mark
  in `public/logos`) and may set a short `navTitle` for the sidebar.
- Screenshots live in `public/screenshots` as WebP. Use `<Screenshot>` for a
  framed image on brand artwork and `<FeatureGrid>`/`<Feature>` for linked
  image cards.

## Vercel project settings

Create a dedicated Vercel project for the docs site with these settings:

| Setting | Value |
| --- | --- |
| Root Directory | `apps/docs` |
| Framework Preset | Next.js |
| Include source files outside Root Directory | Off |
| Install Command | `bun install` |
| Build Command | `bun run build` |
| Output Directory | Leave at the framework default |
| Production Domain | `docs.zuse.sh` |

Keep the deployment scoped to `apps/docs`. If files outside the Root Directory
are included, Bun discovers the repository workspace and attempts to install
unrelated application packages, including private dependencies that the docs do
not use. The install command must not include `cd ../..` or any other
parent-directory traversal. Do not set the output directory to `.next`; the
Next.js preset manages the deployment output.

The Vercel project's Root Directory is a dashboard setting and cannot be set
inside `vercel.json`. After changing it, redeploy the latest commit so the new
working directory is applied.

## Production build

Run the same application build locally from the repository root:

```bash
bun run --cwd apps/docs build
```

No separate documentation CI workflow is required. Git-connected preview and
production deployments are handled by the dedicated Vercel project.
