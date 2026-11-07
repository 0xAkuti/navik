# Swarm in Navik

## What goes where

| Data | Stored on | Field |
|---|---|---|
| Site bytes | Ethereum (ERC-8244 release contract) | — |
| Source of a release: `git archive <commit>` as one tar file | **Swarm** (single-file upload, unencrypted) | — |
| Swarm reference of that tar | **Arkiv**, in the release's `navik.provenance` entity | `sourceSwarm` |
| keccak256 of that tar | **Arkiv**, same entity | `sourceHash` |
| Repo URL, commit, build command, output path | **Arkiv**, same entity | `repo`, `commit`, `build`, `output` |

Why Swarm: the provenance names a git repo, but a repo can be deleted, rewritten or taken down. With the source on Swarm, `navik reproduce <name>` can rebuild a site from content-addressed storage that no git host controls. The tar from `git archive` is deterministic for a commit and carries the commit id in its header, so `navik reproduce` checks three things before building: the bytes hash to `sourceHash`, the tar's embedded commit is the recorded `commit`, and the rebuilt file is byte-identical to what the ENS name serves on Ethereum. A gateway that serves different bytes under the reference is caught by the first check.

The reference is unencrypted on purpose: the source is public, and an encrypted reference (which contains its key) must never go into a public Arkiv entity.

## An example

The dashboard `navik.eth` serves, built from commit `b0ff5a1`:

- Arkiv entity: `0x2ac1462c4b71c425de920c09e69626fc9aabacc90c564c9955500e251a9cdfd5` ([open](https://rabdi.explorer.arkiv.network/entity/0x2ac1462c4b71c425de920c09e69626fc9aabacc90c564c9955500e251a9cdfd5))
- Swarm reference: `b036a86a16a80ec28eed8331bca25bc9dbe2bfb23e1a66d81f0f3f0b65ab367b` ([open](https://api.gateway.ethswarm.org/bzz/b036a86a16a80ec28eed8331bca25bc9dbe2bfb23e1a66d81f0f3f0b65ab367b/), or `bzz://b036a86a16a80ec28eed8331bca25bc9dbe2bfb23e1a66d81f0f3f0b65ab367b` in Freedom)
- keccak256 of the tar: `0xb6bbcd48376fc4ef107420b00d26796032635229a60d7736561edcbed4cf0565`

`navik reproduce navik.eth --yes` fetches that reference from the public gateway, checks the hash and commit, rebuilds, and reports `✓ byte-identical to navik.eth`.

## Postage stamps and node

- Postage batch: `ddf52dccfcbf7c3ebf837a05288a856d68bcc6ceb9a56464cdf0d96d174ee878` (depth 18, about 6.66 MB effective, 30 days from 2026-11-06)
- Bought by: `0xc5cf82fa2ed844b7cf3f022778842e61515f68e5`, the node's wallet on Gnosis Chain, for about 0.145 xDAI
- Node: `antd` 0.5.77, the light node bundled with Freedom, run standalone at `http://127.0.0.1:1633`. Any bee-compatible HTTP API works (`POST /bzz`, `GET /bzz/<ref>/`)
- Reads default to the public gateway `https://api.gateway.ethswarm.org` (`SWARM_API` overrides it)

## Files that upload to and read from Swarm

- [`sdk/src/swarm.ts`](../sdk/src/swarm.ts): `swarmUpload` (POST `/bzz` with the batch id), `swarmDownload` (GET `/bzz/<ref>/`, then the keccak256 check), `swarmLinks`
- [`cli/src/source.ts`](../cli/src/source.ts): `gitArchive`, `tarCommit`, `extractTar`
- [`cli/src/cli.ts`](../cli/src/cli.ts): `deploy --build … --swarm` and `record --swarm` upload; `reproduce` downloads; `provenance` prints the reference
- [`app/src/source.tsx`](../app/src/source.tsx): the viewer links the source as `bzz://` (opens in Freedom) and through the gateway
- [`cli/test/swarm-stub.ts`](../cli/test/swarm-stub.ts): a local stand-in for the two bee API calls, used by the CLI e2e when no batch is available

## Run one upload and one read

Needs: Node ≥ 22.18, pnpm, a git checkout with a built site, a key with tGLM on Arkiv (`ARKIV_PRIVATE_KEY`), a bee/antd node with a usable postage batch, and a Navik deployment to publish to (e.g. the local fork from `scripts/dev-fork.sh`).

```bash
export SWARM_API=http://127.0.0.1:1633 SWARM_BATCH=<batch id> ARKIV_PRIVATE_KEY=0x…
# upload: publishes the release, puts `git archive HEAD` on Swarm, records both on Arkiv
PRIVATE_KEY=$ARKIV_PRIVATE_KEY node cli/src/cli.ts deploy portfolio dist/index.html \
  --build "npm ci && npm run build" --swarm
#   → source       bzz://<reference> (… bytes, git archive <commit>)
#   → provenance   <repo> @ <commit> → Arkiv entity 0x…

# read: fetch the source from Swarm, check its hash and commit, rebuild, compare
node cli/src/cli.ts reproduce portfolio --yes
#   → fetch   <reference> from <SWARM_API>
#   →         ✓ keccak256 matches the provenance, commit <commit>
#   → ✓ byte-identical to portfolio.navik.eth
```

Without a batch, `bash cli/test/e2e.sh` (with `ARKIV_PRIVATE_KEY` set) runs the same flow against the local stand-in.

## Demo video

<!-- TODO(team): timestamp where Swarm is used -->

## What got in our way

- **Postage stamps before the first byte.** Uploading needs a funded postage batch (xBZZ on Gnosis) even for a few hundred KB, so the first integration ran against a stand-in for the bee API. A small free testnet batch, or a faucet-backed upload endpoint for hackathons, would remove that step.
- **The minimum depth is a trap.** Depth 17 is listed as 537 MB but holds 44.7 KB effectively, so a batch has to be sized from the effective volume table. Our 0.8 MB source needed depth 18.
- **Paying in xDAI helped.** `antd` quotes and buys a batch of any size from plain xDAI (`GET /v0/storage/quote`, `POST /v0/storage/buy`), so we never had to acquire xBZZ. It also set up its own chequebook on the first upload. These routes are not in the Bee API docs; we found them in Freedom's source.
- **Single file vs. collection.** A tar uploaded as one file is easy to hash and verify, but cannot be browsed on a gateway. Uploading it as a collection (`swarm-collection: true`) would make the source browsable, but the reference then addresses a manifest, and checking the files against the provenance would need Swarm's chunk hashing on the client.
