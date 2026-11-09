// 账户指代消解：唯一匹配直接用；对上多张就问；说“另一张”就排除刚用过的。

import { isGroupAccount } from './accounts.js';

function postable(accounts) {
  return accounts.filter((account) => !account.archived && !isGroupAccount(accounts, account));
}

/**
 * @returns {{ok:true, account:object} | {ok:false, reason:'none'|'multiple', candidates:object[]}}
 */
export function resolveAccountReference(accounts, reference, context = {}) {
  const lastUsedIds = new Set(context.lastUsedAccountIds || []);
  const text = typeof reference === 'string' ? reference.trim() : '';

  const isAnother =
    context.another === true ||
    text === '另一张' ||
    text === '另一张卡' ||
    text === '别的卡' ||
    text === '另一张信用卡';

  if (isAnother) {
    const candidates = postable(accounts).filter((account) => !lastUsedIds.has(account.id));
    if (candidates.length === 1) return { ok: true, account: candidates[0] };
    return { ok: false, reason: candidates.length ? 'multiple' : 'none', candidates };
  }

  if (!text) {
    if (context.defaultAccountId) {
      const account = accounts.find((candidate) => candidate.id === context.defaultAccountId);
      if (account) return { ok: true, account };
    }
    const candidates = postable(accounts);
    if (candidates.length === 1) return { ok: true, account: candidates[0] };
    return { ok: false, reason: 'none', candidates };
  }

  const exact = postable(accounts).filter(
    (account) => account.id === text || account.name === text || (account.aliases || []).includes(text),
  );
  if (exact.length === 1) return { ok: true, account: exact[0] };
  if (exact.length > 1) return { ok: false, reason: 'multiple', candidates: exact };

  const partial = postable(accounts).filter(
    (account) =>
      account.name.includes(text) || (account.aliases || []).some((alias) => alias.includes(text)),
  );
  if (partial.length === 1) return { ok: true, account: partial[0] };
  if (partial.length > 1) return { ok: false, reason: 'multiple', candidates: partial };
  return { ok: false, reason: 'none', candidates: [] };
}
