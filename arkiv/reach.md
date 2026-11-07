# Reach

## Who it is for

- **Developers who ship frontends onchain** (with Navik, or any ERC-8244 contract site). They already publish immutable bytes; provenance turns "here are some bytes" into "these bytes are commit `f86a646` of this repo, built with this command, and here is the source on Swarm", at no gas cost on Ethereum.
- **Users of those frontends,** especially of dapps that hold funds. Before connecting a wallet to a site, they can see whether its publisher said which code it is, and whether anyone independently rebuilt it. The viewer shows this for any name with a `contentcontract` record, no wallet needed.
- **Auditors and community members** who rebuild frontends. Today a successful reproduction ends up in a chat message or a blog post. Here it becomes a signed, queryable attestation, keyed by content, that every viewer shows.

## Would they use it

Navik could already check a rebuild against a release (`navik verify --against`, `scripts/reproduce.sh`), but the result vanished when the terminal closed, and the recipe (repo, commit, command) had to be known out of band. Arkiv fixes both:
- the recipe ships with the release (`navik deploy --build …`), so `navik reproduce <name> --yes` needs no other input;
- the result is published (`--attest`), so the next user sees "reproduced ×N" instead of re-doing the work;
- CI does it on every release: the GitHub Action's `reproduce` job rebuilds each release on a fresh runner, attests the result with a link to the public run, and blocks promotion on a mismatch. Teams get a reproducibility gate for free, and their users get an attestation per release without anyone running a command. The same job can point at a site you don't own, so an auditor can attest someone else's releases on a schedule.

Writing provenance is one extra flag on a command developers already run, and reading it costs users nothing: it appears in the viewer.

## Can they try it today

- **CLI:** yes, against Arkiv's testnet (Rabdi) and mainnet, or a local mainnet fork (`scripts/dev-fork.sh`, then the commands in the [README](../README.md#provenance-on-arkiv-source-on-swarm)). Writing needs tGLM from the Arkiv faucet; reading needs nothing.
- **Dashboard:** yes, `pnpm -C app dev` or the built single file; the viewer's Source card reads Arkiv for any site.
- **Mainnet:** yes. Navik is live, `navik.eth` and [navik.eth.limo](https://navik.eth.limo) serve the dashboard, and it carries its own provenance, so `navik reproduce navik.eth --yes` rebuilds it from the source on Swarm and compares it byte for byte.

## Will we keep building it

<!-- TODO(team): state plans after Mumbai, e.g. mainnet deployment of Navik, provenance for navik.eth's own releases, attestations from CI. -->
