# setup-soldr-cache-compress

Embedded Node20 GitHub Action used by `setup-soldr` to pre-compress a cache
directory into a single `.tar.zst` file before `actions/cache@v5`'s post-job
save runs, and to decompress it back on restore. Lets `setup-soldr` ship a
uniform zstd wire format across Linux / macOS / Windows regardless of which
codec `actions/cache@v5` would have chosen internally.

## What it does

- **`main`** (restore phase): looks for `<cache-dir>.tar.zst` next to the
  configured `cache-dir`. Sniffs the first 4 bytes:
  - `0x28 B5 2F FD` (zstd magic) -> `zstd -d | tar -xf - -C <parent>`
  - `0x1F 8B` (gzip magic) -> `tar -xzf` (legacy `.tar.gz` back-compat)
  - anything else / missing -> no-op
- **`post`** (post-job hook): tars `<cache-dir>` contents and pipes them
  through `zstd -T0 -<level>` to produce `<cache-dir>.tar.zst`. The
  next-registered `actions/cache@v5` step's post-save then uploads that file.

## Post-job ordering note

GitHub registers `post:` hooks at the moment a JS action's `main:` runs, and
fires them in **reverse** registration order. The composite must register
`actions/cache@v5` *before* this action so the compress post (tar+zstd) runs
first in post-job, with `actions/cache`'s upload post running second.

## Inputs

| Input       | Default | Description                                      |
| ----------- | ------- | ------------------------------------------------ |
| `cache-dir` |  -      | Directory to tar+zstd on save / decompress on restore. |
| `codec`     | `zstd`  | One of `zstd`, `none`, `auto`. `none` writes an uncompressed tar. |
| `level`     | `3`     | zstd compression level (1-22). Clamped on the way in. |

## Local development

```bash
npm install        # installs deps + @vercel/ncc
npm test           # node --test __tests__/*.test.js
npm run build      # bundles src/*.js -> dist/*.js with ncc
```

`dist/main.js` and `dist/post.js` are checked into the repo so consumers do
not need to run `npm install` to use the action; that is the standard
distribution pattern for JS GitHub Actions.
