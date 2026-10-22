# n8n-nodes-buildonce

An [n8n](https://n8n.io) community node for [buildonce.app](https://buildonce.app): templates,
brand assets and a render API for agents, automations and your own product. Use it to render
images and PDFs from your buildonce.app templates directly inside n8n workflows.

## Installation

In n8n: **Settings → Community Nodes → Install**, and search for `n8n-nodes-buildonce`.

Or via npm, in a self-hosted n8n instance:

```
npm install n8n-nodes-buildonce
```

## Credentials

1. Sign in to [buildonce.app](https://buildonce.app) and open **Settings → API Keys**
   (workspace admins only).
2. Create a new key. It starts with `fl_live_` (or `fl_test_` for a key labelled *test*), and
   is shown only once.
3. In n8n, add a new **buildonce.app API** credential and paste the key in.

A key has full access to its workspace's API and is bound to that one workspace. The
credential's **Domain** field defaults to `https://api.buildonce.app`; only change it if you're
pointed at a different environment.

## Operations

Pick a **Resource**, then an **Operation**.

**Template**

- **Render**: render a template to PNG, JPEG, PDF, or a video (MP4, WebM, GIF) with its
  animations, optionally overriding variable values, and get back the resulting file's URL. A
  video takes a few seconds or more to render: by default the node waits for it (up to
  **Timeout**); turn off **Wait for Completion** to get the render ID straight away. Videos
  cost 1 credit per started second, at most 60 s.
- **Get**: fetch a single template's metadata.
- **Get Many**: list templates in your workspace, with search/sort/folder filters.
- **Get Parameters**: list the variables a template accepts (the keys you can set under
  *Modifications* on Render).

**Render**

- **Get**: fetch a render by its ID, with its files and status (`queued`, `processing`,
  `succeeded` or `failed`). Use it to pick up a video you didn't wait for.
- **Get Many**: list past renders in the workspace, filterable by format or template.
  Useful for polling for new renders.
- **Re-Render**: render an existing render again with new variable values, from that render's
  own saved design, so any edits made to it are kept. Every page is rendered; keys can target
  one page (`page2@headline`, or `<pageId>@headline`), and a page key beats a plain one. Keep
  the original format or pick another, including video (which waits like Template → Render).
  The result is a new render whose `sourceRenderId` points back at the original.

## Development

Built with n8n's [`@n8n/node-cli`](https://www.npmjs.com/package/@n8n/node-cli):
`npm run build`, `npm run lint` (n8n's community-node rules, strict mode) and `npm run dev`
(an n8n with this node, rebuilt on change).

Releases are published from GitHub Actions only: merge a version bump, then push a `v*` tag.
The Publish workflow runs `npm run release` (lint, build, publish with npm provenance) and then
checks the published version with n8n's `scan-community-package`. A plain `npm publish` is
refused on purpose.

## Example workflow

1. **Render Template**: pick a template, set a `headline` modification to a value from an
   earlier node.
2. Use the returned `url` field to download the rendered image or post it somewhere else in
   your workflow (Slack, email, social, etc).

## What's new

### 0.2.0
- **Video rendering:** Render Template now renders MP4, WebM and GIF, with video options
  (frames per second, quality, scale). By default the node waits for the video and returns its
  file; turn off **Wait for Completion** to get the render ID straight away.
- **Get Render:** a new operation that fetches a render by ID, with its files and status.
- **Complete lists:** Return All on List Templates and List Renders now returns every result,
  not just the first 100, and the template picker lists all templates, sorted by name.
- **Video formats in the List Renders filter.**
- **Continue On Fail** works for every operation; a failed or timed-out video also outputs its
  render ID.
- **New look:** the buildonce.app name and logo, and working documentation links.
- Requires Node.js 22 or later when installed outside n8n's own runtime.

## Compatibility

Works with n8n 1.x and 2.x (last tested on n8n 2.44), with `n8n-workflow` as a peer
dependency.

## Resources

- [buildonce.app documentation](https://buildonce.app/documentation/get-started/introduction)
- [API keys](https://buildonce.app/documentation/api-keys-scopes)
- [Render API reference](https://buildonce.app/documentation/api-reference/render)
- [Renders API reference](https://buildonce.app/documentation/api-reference/renders)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE.md)
