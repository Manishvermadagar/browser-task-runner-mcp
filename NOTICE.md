# Notices

Browser Task Runner is released under the MIT License (see `LICENSE`).

## chrome-devtools-mcp

Parts of this project are adapted from **chrome-devtools-mcp**
(https://github.com/ChromeDevTools/chrome-devtools-mcp), version 1.9.0,
Copyright 2025 Google LLC, licensed under the Apache License, Version 2.0.

What was adapted:

- `engine/cdp.js`: the browser connection options (attach by `browserURL`,
  by WebSocket endpoint, or by reading a profile's `DevToolsActivePort`
  file; otherwise launch an executable) follow the logic of
  `ensureBrowserConnected()` in chrome-devtools-mcp's `src/browser.ts`.
  The code was rewritten, not copied verbatim.
- `engine/browser.js` and `mcp/server.mjs`: the set and naming of the
  primitive browser tools (`list_pages`, `new_page`, `select_page`,
  `close_page`, `navigate`, `snapshot`, `click`, `fill`, `hover`,
  `wait_for`, `evaluate`, `upload_file`, `screenshot`, network and console
  inspection) are modelled on chrome-devtools-mcp's tool set. The
  implementations, the uid scheme and the safety rules are this project's
  own.

chrome-devtools-mcp is not bundled or required at runtime. This project
depends on `puppeteer-core` (Apache-2.0, Google LLC) directly, as
chrome-devtools-mcp does.

Apache License 2.0 notice for the adapted portions:

    Copyright 2025 Google LLC

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

## Other dependencies

- `@modelcontextprotocol/sdk` (MIT)
- `puppeteer-core` (Apache-2.0)
- `zod` (MIT)
