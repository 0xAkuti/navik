# Arkiv schema

Navik writes two kinds of entities to Arkiv's testnet (Rabdi, chain 7794095). Both are defined with the SDK's `defineSchema` in [`sdk/src/arkiv.ts`](../sdk/src/arkiv.ts), so every entity carries an indexed `arkiv.schema` tag and queries through a schema only match its own entities.

Both are created with the same options:

| Option | Value | Why |
|---|---|---|
| `readonly` | true | A record describes an immutable release (or a rebuild of one). Nobody, including its writer, can edit it afterwards. |
| `permissionlessExtension` | true | Anyone who relies on a record can keep it alive past Arkiv's maximum lifetime, without being able to change it. |
| Lifetime | 180 days (Arkiv's cap is ~182.5) | Extended with `navik keep-alive <name>` or the dashboard's "Keep alive" button, by anyone. |
| Owner | The writing wallet | Trust is decided on `$creator`, which is fixed at creation; `$owner` can be transferred. |

## `navik.provenance`: which source built a release

Written by `navik deploy` (by default from `navik.json`, with `--build <cmd>` for a path) or `navik record`, signed by the deploy key.

| Column | Type | Indexed | Meaning |
|---|---|---|---|
| `chainId` | u64 | yes | Chain the site lives on (1 = mainnet, 31337 = local fork) |
| `site` | addr | yes | The ERC-8244 contract (`contentcontract`) of the release |
| `contentHash` | key | yes | keccak256 of the exact bytes `html()` returns |
| `name` | str | yes | The release's permanent name, e.g. `3.portfolio.navik.eth` |
| `project` | str | yes | The production name, e.g. `portfolio.navik.eth`; lists a project's records in one query |
| `version` | u64 | no | Release number |
| `repo` | str | no | Public URL of the source: https, or `rad://<rid>` for Radicle |
| `commit` | str | yes | Full commit hash the release was built from |
| `build` | str | no | Command, run at the repo root, that builds the site |
| `output` | str | no | Path of the built file in the repo |
| `sourceSwarm` | str | no (optional) | Swarm reference of `git archive <commit>` (an unencrypted, single-file tar) |
| `sourceHash` | key | no (optional) | keccak256 of that tar, checked after every download |
| `notes` | bytes | no (optional) | Release notes, UTF-8 |

**Who can write one:** anyone. **Which one counts:** a client trusts a record only when `$creator` equals the `publisher` in the Navik factory's `DeploymentPublished` event for that release (read from Ethereum). Records by anyone else are shown as ignored. For non-Navik ERC-8244 sites there is no publisher to check, so no record is trusted.

**Queries:**
- by site: `arkiv.schema = str('navik.provenance') AND chainId = u64(1) AND site = addr(0x…)` (viewer, `navik provenance`, `navik reproduce`)
- by project: `… AND project = str('portfolio.navik.eth')` (`provenanceOfProject`)

## `navik.attestation`: who rebuilt it, and did it match

Written by `navik reproduce <name> --yes --attest` (also from CI: the GitHub Action's `reproduce` mode), `navik verify <name> --against <file> --attest`, or the dashboard's "Attest" button after "Compare with a local build". Signed by whoever rebuilt the site.

| Column | Type | Indexed | Meaning |
|---|---|---|---|
| `chainId` | u64 | yes | Chain the site lives on |
| `site` | addr | yes | The contract that was checked |
| `contentHash` | key | yes | keccak256 of its bytes: attestations follow the content, so any ERC-8244 site works |
| `name` | str | yes | The name the builder resolved |
| `result` | str | yes | `match` (byte-identical) or `mismatch` |
| `builtHash` | key | no | keccak256 of the builder's file |
| `provenance` | key | no (optional) | Key of the provenance entity whose recipe was rebuilt |
| `repo`, `commit`, `build` | str | no (optional) | The recipe used, copied from that provenance |
| `tool` | str | no | `navik-cli`, `navik-ci` or `navik-dashboard` |
| `log` | str | no (optional) | Public https log of the rebuild, e.g. the GitHub Actions run; the viewer links it |

**Who can write one:** anyone; an attestation is a signed claim by its creator, shown with the creator's address (or primary ENS name). Mismatches are kept and shown in red.

**Query:** `arkiv.schema = str('navik.attestation') AND chainId = u64(1) AND contentHash = key(0x…)`

## Expiry and extension

| Entity | Expires | Extended by |
|---|---|---|
| `navik.provenance` | 180 days after creation or last extension | anyone (`navik keep-alive`, dashboard "Keep alive") |
| `navik.attestation` | 180 days after creation or last extension | anyone (same) |

The dashboard shows each record's approximate expiry date, computed from `$expiresAt` and the current Arkiv block (2-second blocks).
