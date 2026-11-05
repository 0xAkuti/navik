# Navik

Vercel-style deployments for fully onchain websites, controlled by ENSv2.

- Every release is an immutable ERC-8244 contract whose `html()` returns the site.
- Every release gets a permanent name: `<project>-v<N>.navik.eth`.
- Production is `<project>.navik.eth`, a `contentcontract` text record on the project's own ENSv2 Permissioned Resolver. Promote and rollback are one ENS write.
- Who may deploy is an ENSv2 Enhanced Access Control grant that the project owner can revoke.
