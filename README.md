# n8n-nodes-buildonce

An [n8n](https://n8n.io) community node for [BuildOnce](https://buildonce.app) — render images
and PDFs from your BuildOnce templates directly inside n8n workflows.

## Installation

In n8n: **Settings → Community Nodes → Install**, and search for `n8n-nodes-buildonce`.

Or via npm, in a self-hosted n8n instance:

```
npm install n8n-nodes-buildonce
```

## Credentials

1. Sign in to BuildOnce and go to **Workspace → Settings → API Keys**.
2. Create a new key (it starts with `fl_live_`).
3. In n8n, add a new **BuildOnce API** credential and paste the key in.

The credential's **Domain** field defaults to `https://api.buildonce.app` — only change it if
you're pointed at a different environment.

## Operations

- **List Templates** — list templates in your workspace, with search/sort/folder filters.
- **Get Template** — fetch a single template's metadata.
- **Get Template Parameters** — list the variables a template accepts (the keys you can set
  under *Modifications* on Render Template).
- **Render Template** — rasterize a template to PNG, JPEG or PDF, optionally overriding
  variable values, and get back the resulting file's URL.
- **List Renders** — list past renders in the workspace, filterable by format or template.
  Useful for polling for new renders.

## Example workflow

1. **Render Template**: pick a template, set a `headline` modification to a value from an
   earlier node.
2. Use the returned `url` field to download the rendered image or post it somewhere else in
   your workflow (Slack, email, social, etc).

## Compatibility

Tested against n8n 1.x with `n8n-workflow` as a peer dependency.

## Resources

- [BuildOnce documentation](https://buildonce.app/docs)
- [n8n community nodes documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](LICENSE.md)
