# How Navik uses Arkiv

Navik publishes fully onchain websites: each release is an immutable ERC-8244 contract on Ethereum with a permanent ENSv2 name. Ethereum proves *what bytes* a name serves. It cannot say *where those bytes came from* without storing a repo URL, commit and build command in bytecode for every release, which costs gas and can never be corrected. Arkiv holds that layer: release provenance written by the publisher, and reproducibility attestations written by anyone who rebuilt a site.

## Fields we filter on, and why they fit

| Query | Filter | Used by |
|---|---|---|
| Provenance of the site I'm looking at | `chainId`, `site` (the release contract) | Viewer "Source" card, `navik provenance`, `navik reproduce` |
| Every release of a project | `chainId`, `project` | SDK `provenanceOfProject` |
| Who rebuilt these bytes | `chainId`, `contentHash` | Viewer "reproduced ×N" badge and list, `navik provenance` |

`contentHash` is the key design choice: attestations are keyed by content, not by name or contract. Two releases with identical bytes share their attestations, and any ERC-8244 site (not only Navik's) can be attested and looked up by anyone who can hash its bytes. Every other column (`repo`, `build`, `notes`, …) is stored but not indexed, because nobody searches by it.

## Who can edit what

- **Nobody can edit a record**, including its writer: both entity types are created `readonly`, like the releases they describe. A correction is a new record. The client takes the newest one written by the publisher.
- **Trust comes from the writer, not from the schema.** Anyone can write a `navik.provenance` entity for any release. The client only trusts one whose `$creator` (fixed at creation, unlike `$owner`) equals the `publisher` that Navik's factory recorded on Ethereum when the release was published. Records by others are listed as ignored. This ties Arkiv data to the ENSv2 permission model: only a key granted "publish releases" on the project can publish, so only such a key can write trusted provenance.
- **Attestations are signed claims.** They are shown with their creator's primary ENS name, or address if it has none; mismatches are kept and shown in red, not hidden. One from CI links its public build log, so anyone can read how the rebuild ran.

## Expiry

Releases on Ethereum never expire, but Arkiv entities do: the protocol caps a lifetime at ~182.5 days. We create records for 180 days with `permissionlessExtension`, so:
- the publisher, a builder, or any user who cares about a site can extend its records ("Keep alive" in the viewer, `navik keep-alive` in the CLI) without being able to change them;
- the viewer shows each record's expiry date, so users see when one needs extending;
- a record that lapses is just provenance that nobody kept; the site itself stays verified from Ethereum.

## Arkiv features that change what users see

| Feature | What the user sees |
|---|---|
| Indexed attribute queries (`site`, `contentHash`, `project`) | The viewer's Source card: repo and commit, build command, Swarm link, and "reproduced ×N" for any site opened |
| `$creator` | "Provenance recorded by the publisher 0x…", or "N records by other accounts ignored" |
| `readonly` | Records cannot be quietly rewritten after people relied on them |
| `permissionlessExtension` + `$expiresAt` | "On Arkiv until ~2027-05-04" and a "Keep alive 180 days" button that works for any wallet |
| Wallet-owned writes | "Attest: I reproduced it" in the viewer, signed by the user's own wallet; no Navik server or API key involved |
| Writes from CI | A `reproduce` job in the GitHub Action rebuilds each release on a fresh runner and attests it with a key that has no Ethereum permissions. Production is only promoted once that attestation says `match`. Viewers show it as "via navik-ci" with a "build log" link |

## What stays off Arkiv

- **Site bytes, names, content hashes, permissions:** on Ethereum, where they are immutable and verifiable. Arkiv never decides what a name serves.
- **Source code:** on Swarm (a tar of `git archive <commit>`), referenced from the provenance record with its keccak256. Arkiv's 128 KiB entity limit is not meant for repositories.
- **Nothing private:** every record is public by design.

## Reading privately

The dashboard reads Arkiv through anon-rpc, like every Ethereum read: Arkiv's RPC sees a mixnet exit, not which sites a user inspects. Arkiv reads get their own route (Nox by default; Nym's worker drops the `Content-Type` header the Arkiv node requires), visible and configurable in the privacy panel. The wallet only signs.

## Where the code is

- Schemas, queries, trust check, writes: [`sdk/src/arkiv.ts`](../sdk/src/arkiv.ts)
- Calldata for browser wallets, tested byte for byte against the Arkiv SDK: [`sdk/test/arkiv-encoding.test.ts`](../sdk/test/arkiv-encoding.test.ts)
- CLI commands (`deploy --build`, `record`, `provenance`, `reproduce`, `keep-alive`, `verify --attest`): [`cli/src/cli.ts`](../cli/src/cli.ts)
- Viewer Source card: [`app/src/source.tsx`](../app/src/source.tsx); Arkiv reads and wallet writes: [`app/src/arkiv.ts`](../app/src/arkiv.ts)
