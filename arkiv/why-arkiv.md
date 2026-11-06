# Why Arkiv

## What users would lose if this lived in Postgres

Navik's premise is that nothing about a site depends on us: no server, gateway, indexer or relayer (see the CROPS section of the [README](../README.md)). Release provenance and attestations in a Postgres database behind a Navik API would undo that:

- **A party in the middle.** Whoever runs the database decides which provenance and attestations exist. They could drop an inconvenient "my build differs" report, or rewrite which commit a release claims to come from. On Arkiv, records are `readonly` from the moment they land: nobody can edit them, us included.
- **Unsigned rows.** The trust rule is "provenance counts only if its writer published the release". On Arkiv every entity has a `$creator`, which is the address that signed the transaction and cannot change. Postgres would need its own signature scheme, key handling and verification, and users would still have to trust that the server checked it.
- **Permission to participate.** Anyone can attest that they rebuilt a site, from the CLI or with any wallet in the dashboard, without an account or an API key from us. With a database, we would be the gatekeeper of who may vouch for whom.
- **Records that outlive the team.** If Navik disappears, Arkiv records stay readable through any Arkiv RPC, and anyone can extend them (`permissionlessExtension`). A database goes down with its operator.
- **Private reads through any RPC.** The dashboard reads Arkiv through anon-rpc, so Arkiv's RPC sees a mixnet exit, not which sites a user inspects. A Navik API would see every lookup with the user's IP, unless we also built and ran an anonymizing proxy.
- **One query model for everyone.** The CLI, the dashboard and any third-party tool use the same public query (`contentHash = key(0x…)`) on the same data; there is no private API to reverse-engineer.

## What we kept off Arkiv, and why

| Data | Where | Why not Arkiv |
|---|---|---|
| Site bytes, release names, content hashes | Ethereum (ERC-8244 contracts, ENSv2) | They must be immutable forever and decide what a name serves; Arkiv entities expire and Arkiv is a testnet today. |
| Who may publish or change production | Ethereum (ENSv2 Enhanced Access Control) | It is part of the name's security model; Arkiv provenance trust is derived from it, not the other way round. |
| Source code | Swarm (`git archive` tar, referenced by `sourceSwarm` + `sourceHash`) | Repositories are larger than Arkiv's 128 KiB per entity, and file storage is what Swarm is for. |
| The publisher of a release | Ethereum (`DeploymentPublished` event) | It is the anchor the Arkiv trust check compares against, so it cannot come from Arkiv itself. |

Arkiv holds exactly what Ethereum is too expensive and too rigid for: small, structured, queryable, signed facts *about* immutable releases, some written by people who are not the publisher.
