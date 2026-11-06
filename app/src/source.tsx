import * as navik from '@navik/sdk'
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { Address, EIP1193Provider } from 'viem'

import { arkivRead, entityUrl, onArkiv, sendArkiv } from './arkiv.ts'
import { ARKIV_CHAIN_ID, networkById, reconnect, useReads } from './reads.ts'
import { Badge, Hash, Icon, Mono, Spinner, Who } from './ui.tsx'

export type Wallet = { provider: EIP1193Provider; account: Address }
export type Compared = { file: string; cmp: navik.BuildComparison }

type Records = {
  provenance: navik.Provenance[]
  trusted?: navik.Provenance
  publisher?: Address
  attestations: navik.Attestation[]
  block: bigint
}

/**
 * Where a site's code came from and who rebuilt it, from Arkiv: the publisher's provenance record
 * (repo, commit, build command, a hash-pinned copy of the source on Swarm) and attestations from
 * anyone who rebuilt the bytes. Optional by design: if Arkiv is unreachable the site is still
 * verified and rendered from Ethereum alone.
 */
export function SourcePanel(props: { ctx: navik.Ctx; v: navik.Verification; isolationKey: string; wallet?: Wallet; compared?: Compared }) {
  const { ctx, v, isolationKey, wallet, compared } = props
  const reads = useReads()
  const [records, setRecords] = useState<Records>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [notice, setNotice] = useState<{ ok: boolean; text: string }>()
  const [reload, setReload] = useState(0)
  const chainId = ctx.deployment.chainId
  const arkivNet = reads.routes[ARKIV_CHAIN_ID] && networkById(reads.routes[ARKIV_CHAIN_ID].network)
  const retry = () => {
    if (arkivNet && reads.phases[arkivNet.id]?.phase === 'failed') reconnect()
    setReload((n) => n + 1)
  }

  useEffect(() => {
    let cancelled = false
    setError(undefined)
    const arkiv = arkivRead(isolationKey)
    // two sources: say which one failed
    const from = <T,>(source: string, read: Promise<T>) =>
      read.catch((err) => {
        throw new Error(`${source}: ${navik.describeError(err)}`)
      })
    Promise.all([
      from('Arkiv', Promise.all([navik.provenanceOf(arkiv, chainId, v.deployment), navik.attestationsOf(arkiv, chainId, v.contentHash), navik.arkivBlock(arkiv)])),
      v.isNavikDeployment ? from('Ethereum', navik.publisherOf(ctx, v.deployment)) : undefined,
    ])
      .then(([[provenance, attestations, block], publisher]) => {
        if (cancelled) return
        setRecords({ provenance, attestations, publisher, block, trusted: navik.trustedProvenance(provenance, publisher) })
      })
      .catch((err) => !cancelled && setError((err as Error).message))
    return () => {
      cancelled = true
    }
  }, [ctx, v, isolationKey, reload])

  /** Signs on Arkiv with the wallet, then re-reads. */
  const act = async (label: string, call: navik.ArkivCall) => {
    if (!wallet) return
    setBusy(label)
    setNotice(undefined)
    try {
      const res = await onArkiv(wallet.provider, () => sendArkiv(wallet.provider, wallet.account, call, isolationKey))
      setNotice({ ok: true, text: `${label}: done (tx ${res.txHash.slice(0, 10)}…)` })
      setReload((n) => n + 1)
    } catch (err) {
      setNotice({ ok: false, text: `${label} failed: ${navik.describeError(err)}` })
    } finally {
      setBusy(undefined)
    }
  }

  const p = records?.trusted
  const matches = records?.attestations.filter((a) => a.result === 'match') ?? []
  const mismatches = records?.attestations.filter((a) => a.result === 'mismatch') ?? []
  const ignored = records ? records.provenance.filter((r) => r !== p).length : 0
  const until = (at: bigint) => navik.expiryDate(at, records!.block).toISOString().slice(0, 10)
  const keepAliveKeys = records ? [...(p ? [p.key] : []), ...records.attestations.map((a) => a.key)] : []

  return (
    <section class="card verify source" aria-label="Source and reproductions">
      <div class="row">
        <h3>Source</h3>
        <span class="spacer" />
        {records && !error && (
          <Badge tone={matches.length && !mismatches.length ? 'ok' : mismatches.length ? 'warn' : 'muted'}>
            {matches.length ? `reproduced ×${matches.length}` : p ? 'not reproduced yet' : 'no provenance'}
          </Badge>
        )}
      </div>

      {!records && !error && (
        <p class="muted small row">
          <Spinner /> Reading provenance from Arkiv{arkivNet ? ` via ${arkivNet.name}` : ''}…
        </p>
      )}
      {error && (
        <p class="muted small">
          Provenance is unavailable; the site itself is verified on Ethereum above. <span class="error">{error}</span>{' '}
          <button class="btn sm" onClick={retry}>
            Retry
          </button>
        </p>
      )}

      {records && !error && (
        <>
          <ul class="checks">
            {p ? (
              <Check ok>
                Provenance recorded on Arkiv by the publisher <Who ctx={ctx} address={p.creator} chainId={chainId} />
              </Check>
            ) : (
              <Check>
                No provenance from {records.publisher ? <>the publisher <Who ctx={ctx} address={records.publisher} chainId={chainId} /></> : 'a known publisher'}
                {ignored > 0 && `; ${ignored} record${ignored === 1 ? '' : 's'} by other accounts ignored`}
              </Check>
            )}
            {p?.sourceSwarm && <Check ok>Source archived on Swarm, pinned by its keccak256</Check>}
            {matches.length > 0 && (
              <Check ok>
                Rebuilt byte for byte by {matches.length} builder{matches.length === 1 ? '' : 's'}
              </Check>
            )}
            {mismatches.length > 0 && (
              <Check ok={false}>
                {mismatches.length} builder{mismatches.length === 1 ? '' : 's'} could not reproduce it
              </Check>
            )}
          </ul>

          {p && (
            <dl class="facts">
              <dt>Repo</dt>
              <dd>
                <a class="ext" href={repoLink(p.repo, p.commit)} target="_blank" rel="noopener noreferrer">
                  {p.repo.replace(/^https?:\/\//, '')}
                </a>
              </dd>
              <dt>Commit</dt>
              <dd>
                <Hash value={p.commit} chars={12} />
              </dd>
              <dt>Build</dt>
              <dd>
                <Mono>{p.build}</Mono> → <Mono>{p.output}</Mono>
              </dd>
              {p.sourceSwarm && (
                <>
                  <dt>Swarm</dt>
                  <dd>
                    <a href={navik.swarmLinks(p.sourceSwarm).bzz} title="Opens in Swarm-native browsers such as Freedom">
                      <Mono>bzz://{p.sourceSwarm.slice(0, 10)}…</Mono>
                    </a>{' '}
                    ·{' '}
                    <a class="ext" href={navik.swarmLinks(p.sourceSwarm).gateway} target="_blank" rel="noopener noreferrer">
                      gateway
                    </a>
                  </dd>
                </>
              )}
              {p.notes && (
                <>
                  <dt>Notes</dt>
                  <dd>{p.notes}</dd>
                </>
              )}
              <dt>On Arkiv</dt>
              <dd>
                <a class="ext" href={entityUrl(p.key)} target="_blank" rel="noopener noreferrer">
                  <Mono>{p.key.slice(0, 10)}…</Mono>
                </a>{' '}
                until ~{until(p.expiresAt)}
              </dd>
            </dl>
          )}

          {records.attestations.length > 0 && (
            <ul class="attests">
              {records.attestations.map((a) => (
                <li key={a.key} class={a.result === 'match' ? '' : 'error'}>
                  <Icon name={a.result === 'match' ? 'check' : 'x'} size={14} />
                  <Who ctx={ctx} address={a.creator} chainId={ARKIV_CHAIN_ID} />
                  <span class="muted small">
                    {a.commit ? `@ ${a.commit.slice(0, 8)} ` : ''}via {a.tool}
                  </span>
                  {a.log?.startsWith('https://') && (
                    <a class="ext small" href={a.log} target="_blank" rel="noopener noreferrer" title={a.log}>
                      build log
                    </a>
                  )}
                  <a class="ext small" href={entityUrl(a.key)} target="_blank" rel="noopener noreferrer" title={`until ~${until(a.expiresAt)}`}>
                    entity
                  </a>
                </li>
              ))}
            </ul>
          )}

          {p && (
            <p class="small muted">
              Rebuild it yourself: <Mono>navik reproduce {v.name} --yes</Mono>, or build it and drop the file below.
            </p>
          )}

          <div class="row">
            {compared && (
              <button
                class="btn sm primary"
                disabled={!wallet || !!busy}
                title={wallet ? undefined : 'Connect a wallet to sign on Arkiv'}
                onClick={() =>
                  act(
                    'Attest on Arkiv',
                    navik.attestationCall({
                      chainId,
                      site: v.deployment,
                      contentHash: v.contentHash,
                      name: v.name,
                      result: compared.cmp.matches ? 'match' : 'mismatch',
                      builtHash: compared.cmp.hash,
                      provenance: p?.key,
                      repo: p?.repo,
                      commit: p?.commit,
                      build: p?.build,
                      tool: 'navik-dashboard',
                    }),
                  )
                }
              >
                {busy === 'Attest on Arkiv' ? <Spinner /> : <Icon name="check" size={14} />}
                {compared.cmp.matches ? 'Attest: I reproduced it' : 'Report: my build differs'}
              </button>
            )}
            {keepAliveKeys.length > 0 && (
              <button
                class="btn sm"
                disabled={!wallet || !!busy}
                title={wallet ? 'Anyone may extend these records; they cannot change them' : 'Connect a wallet to sign on Arkiv'}
                onClick={() => act('Keep alive', navik.keepAliveCall(keepAliveKeys))}
              >
                {busy === 'Keep alive' ? <Spinner /> : null}
                Keep alive {navik.ARKIV_LIFETIME_DAYS} days
              </button>
            )}
          </div>
          {compared && !wallet && <p class="small muted">Connect a wallet (with tGLM on Arkiv) to publish your result.</p>}
          {notice && <p class={`small ${notice.ok ? 'ok-text' : 'error'}`}>{notice.text}</p>}
        </>
      )}
    </section>
  )
}

function Check(props: { ok?: boolean; children: ComponentChildren }) {
  return (
    <li class={props.ok === undefined ? 'muted' : props.ok ? '' : 'error'}>
      <Icon name={props.ok === false ? 'x' : props.ok ? 'check' : 'chevron'} size={14} />
      <span>{props.children}</span>
    </li>
  )
}

/** GitHub/GitLab/Codeberg URLs link to the tree at the commit; anything else to the repo. */
function repoLink(repo: string, commit: string): string {
  return /^https:\/\/(github\.com|gitlab\.com|codeberg\.org)\//.test(repo) ? `${repo}/tree/${commit}` : repo
}
