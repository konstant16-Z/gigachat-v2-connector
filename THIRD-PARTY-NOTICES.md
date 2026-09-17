# Third-Party Notices

`gigachat-v2-connector` is an independent OpenCode plugin. It uses the
components and references below. This file does not claim derivation where no
code was copied.

## Upstream project

| Project | Author | Relation | License |
|---|---|---|---|
| [opencode-gigachat-plugin](https://github.com/Overman775/opencode-gigachat-plugin) | [Overman775](https://github.com/Overman775) | The original OpenCode **V1** plugin. This repository is a TypeScript port/reconstruction of its published bundle (`v1.0.0`) onto the OpenCode **V2** plugin contract, preserving behavior and adding the V2 pipeline. | MIT (per the upstream project) |

The parallel multi-tool-call pairing behavior (`pendingCalls` /
`toolCallIdToName`) originates in the upstream bundle and is preserved here.

## Comparison target (no code copied)

| Project | Relation |
|---|---|
| [gpt2giga](https://github.com/ai-forever/gpt2giga) | An independent Python proxy that also speaks the GigaChat API. It is referenced **only** as a benchmark/comparison target in [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) and `scripts/bench/`. **No source code from gpt2giga is copied, adapted, or derived.** |

## Runtime dependencies

| Package | Version (lockfile) | License |
|---|---|---|
| [axios](https://github.com/axios/axios) | 1.20.0 | MIT |
| [form-data](https://github.com/form-data/form-data) | 4.0.6 | MIT |
| [uuid](https://github.com/uuidjs/uuid) | 11.1.1 | MIT |

## Development dependencies

| Package | Version (lockfile) | License |
|---|---|---|
| [typescript](https://github.com/microsoft/TypeScript) | 5.9.3 | Apache-2.0 |
| [@biomejs/biome](https://github.com/biomejs/biome) | 2.5.13 | MIT OR Apache-2.0 |
| [@types/node](https://github.com/DefinitelyTyped/DefinitelyTyped) | 22.20.1 | MIT |
| [bun-types](https://github.com/oven-sh/bun) | 1.4.2 | MIT |

## Specifications and reference material

| Material | Source | Purpose |
|---|---|---|
| GigaChat API OpenAPI specification | <https://developers.sber.ru/docs/files/openapi/gigachat/api.yml> | Wire contract (a local copy is kept in [`docs/external/gigachat-api.yml`](docs/external/gigachat-api.yml)) |
| GigaChat «Сгенерировать ответ V2» reference page | <https://developers.sber.ru/docs/ru/gigachat/api/reference/rest/post-chat-v-2> | Response codes and limits (local copy in [`docs/external/gigachat-post-chat-v2-page.md`](docs/external/gigachat-post-chat-v2-page.md)) |
| Russian Trusted Root CA | Ministry of Digital Development of Russia (<https://rootca.ru>) | TLS trust anchor bundled as a fallback PEM in `src/v2/net.ts`; the certificate is public key material, not code |

## GigaChat / GigaCode trademarks

GigaChat, GigaCode and SberCloud are trademarks of their respective owners.
This project is an unofficial integration and is not affiliated with or
endorsed by Sber.

---

*If you believe an attribution is missing or incorrect, open an issue.*
