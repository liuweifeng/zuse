# Third-party notices

This file records third-party code, assets, and dependencies distributed with Zuse.

## Diagram source validation

The Mermaid unsafe-source policy, tests, and hardened initialization in
`packages/client-runtime/src/mermaid-source-policy.ts`,
`packages/client-runtime/test/unit/mermaid-source-policy.test.ts`,
`apps/renderer/src/components/markdown-body.tsx`, and
`apps/mobile/src/components/messages/mermaid-diagram.tsx` include adapted
third-party code.

Copyright (c) 2025-present Mohamed Boudra.

The original material is licensed under `AGPL-3.0-or-later`. Zuse selected version 3,
modified the material on 2026-08-23, and distributes the resulting work under
`AGPL-3.0-only`. The complete GNU Affero General Public License version 3 is
reproduced in [`LICENSE`](LICENSE).

## Linux package installation hooks

The alternative-link and desktop-cache handling in
`apps/desktop/build/linux/after-install.tpl` and `after-remove.tpl` is adapted
from electron-builder's Linux templates at version 25.1.8
([revision 1d61d6f](https://github.com/electron-userland/electron-builder/tree/1d61d6f59061be23d5cd8602a65e8ce10861ccc0/packages/app-builder-lib/templates/linux)).

Copyright (c) 2015 Loopline Systems.

These templates are licensed under MIT; the permission and warranty terms in
the preserved MIT license below also apply to these adaptations.

## Library and framework foundations

The project also builds directly on public libraries and component registries:

- Effect and `@effect/*` provide the service, schema, streaming, and RPC model;
  [PR #3](https://github.com/swarajbachu/zuse/pull/3) records the official
  Effect protocol as the implementation reference;
- shadcn/ui, Base UI, and configured component registries provide UI primitives
  that are generated and then maintained in this repository;
- the public icon data package and its React and React Native renderers provide
  the default contributor icon set; licensed release builds may use separately
  installed paid icon data governed by its own license terms;
- CodeMirror and the Pierre packages provide editor, diff, and tree
  foundations;
- Ghostty's `libghostty-vt` provides the terminal state machine used by the
  WebAssembly, iOS, and Android renderers. Its exact pinned revision and MIT
  license are distributed under `native/libghostty-vt/` and alongside the
  mobile vendor artifacts;
- Next.js and Fumadocs provide the documentation application.

The packages and licenses distributed with these dependencies provide their
terms. Package-specific adaptations are documented separately;
for example, see [`packages/tokenmaxer/NOTICE.md`](packages/tokenmaxer/NOTICE.md).

## Pi provider branding and protocol

Pi's provider icon uses the paths from the official
[Pi logo](https://pi.dev/logo-auto.svg), retrieved on 2026-09-11. The paths are
used in the desktop and website icons and rasterized for mobile provider icons
by `scripts/gen-provider-logos.mjs`. The logo identifies the integrated provider;
it is not original Zuse artwork.

The Pi driver is an independent implementation of the documented
[Pi RPC protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md).
It launches the user's installed CLI and does not bundle Pi's SDK or CLI.
