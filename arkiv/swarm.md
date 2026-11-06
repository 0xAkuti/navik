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

<!-- TODO(team): fill in after the first upload with the real batch -->
- Arkiv entity: `0x…` (open: `https://rabdi.explorer.arkiv.network/entity/0x…`)
- Swarm reference: `…` (open: `https://api.gateway.ethswarm.org/bzz/<reference>/`, or `bzz://<reference>` in Freedom)

## Postage stamps and node

<!-- TODO(team): batch id, the wallet that bought it (or who gave it), and the node -->
- Postage batch: `…`
- Bought by / provided by: `…`
- Node: bee-compatible HTTP API (`POST /bzz`, `GET /bzz/<ref>/`), e.g. a bee node or Freedom's `antd` light node at `http://127.0.0.1:1633`
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
- **Single file vs. collection.** A tar uploaded as one file is easy to hash and verify, but cannot be browsed on a gateway. Uploading it as a collection (`swarm-collection: true`) would make the source browsable, but the reference then addresses a manifest, and checking the files against the provenance would need Swarm's chunk hashing on the client.
