import { BaseError, ContractFunctionRevertedError } from 'viem'

/** Short message for any error, with decoded revert reasons (e.g. `EACUnauthorizedAccountRoles(...)`). */
export function describeError(err: unknown): string {
  if (!(err instanceof BaseError)) return err instanceof Error ? err.message : String(err)
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
  if (revert?.data) return `${err.shortMessage} ${revert.data.errorName}(${(revert.data.args ?? []).join(', ')})`
  return err.shortMessage
}
