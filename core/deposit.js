// 定期存款：借记卡账户组下的活期 + 多个定期子账户。
// 利息按实际天数 / 当年实际天数（365 或 366）单利计算。

import { addDays, addMonths, daysBetween } from './dates.js';
import { accountBalanceCents, ensureAccountGroup, ensureChildAccount, createAccount, renameAccount, resolveAccount } from './accounts.js';
import { buildVoucher, postVoucher, todayInShanghai } from './ledger.js';
import { formatYuan, parseAmountToCents } from './money.js';

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 单利：本金 × 年利率 × 实际天数 / 当年实际天数；跨年按年拆分。 */
export function interestForPeriod(principalCents, annualRateBps, from, toInclusive) {
  if (principalCents <= 0 || annualRateBps <= 0) return 0;
  const endExclusive = addDays(toInclusive, 1);
  if (daysBetween(from, endExclusive) <= 0) return 0;

  let total = 0;
  let cursor = from;
  while (cursor < endExclusive) {
    const year = Number(cursor.slice(0, 4));
    const yearEnd = `${year + 1}-01-01`;
    const segmentEnd = endExclusive < yearEnd ? endExclusive : yearEnd;
    const days = daysBetween(cursor, segmentEnd);
    total += (principalCents * annualRateBps * days) / (10_000 * (isLeapYear(year) ? 366 : 365));
    cursor = segmentEnd;
  }
  return Math.round(total);
}

function fixedMeta(account) {
  return account && account.meta ? account.meta.fixed_deposit : null;
}

export function ensureBankSetup(store, bankName, demandName) {
  const existing = store.accounts.find((account) => account.name === bankName);
  if (existing && !store.accounts.some((account) => account.parentId === existing.id)) {
    // 银行卡原来是叶子账户：改名成活期，再建同名账户组，把活期挂进去。
    renameAccount(store, existing, { newName: demandName, keepOldName: false });
    existing.aliases = [...new Set((existing.aliases || []).filter((alias) => alias !== bankName))];
    const group = createAccount(store.accounts, { name: bankName });
    existing.parentId = group.id;
    store.saveAccounts();
    store.audit({
      action: 'account-group-from-leaf',
      accountId: existing.id,
      groupId: group.id,
      at: new Date().toISOString(),
    });
    return { group, demand: existing };
  }
  const group = ensureAccountGroup(store, bankName);
  const demand = ensureChildAccount(store, bankName, demandName, {
    initialKnown: true,
    initialBalanceCents: 0,
  });
  return { group, demand };
}

export function openFixedDeposit(store, options = {}) {
  const bankName = options.bank;
  const demandName = options.demand || `${bankName}活期`;
  if (!bankName) throw new Error('要告诉我是哪张借记卡/银行');
  const amountCents = parseAmountToCents(options.amount);
  const termMonths = Number(options.termMonths);
  const annualRateBps = Math.round(Number(options.ratePercent || 0) * 100);
  const startDate = options.date || todayInShanghai();
  if (!Number.isFinite(termMonths) || termMonths <= 0) throw new Error('定期期限要大于 0 个月');
  if (amountCents <= 0) throw new Error('定期金额要大于 0');

  const { group, demand } = ensureBankSetup(store, bankName, demandName);
  const demandBalance = accountBalanceCents(demand, store.vouchers());
  if (demandBalance < amountCents) {
    throw new Error(`活期余额不够：${demandName} 现在 ${formatYuan(demandBalance)}`);
  }

  const siblings = store.accounts.filter((account) => account.parentId === group.id && fixedMeta(account));
  const baseName = options.name || `定期${siblings.length + 1}`;
  const fixed = createAccount(store.accounts, {
    name: baseName,
    parentId: group.id,
    initialKnown: true,
    initialBalanceCents: 0,
    tags: ['fixed_deposit'],
  });
  const maturityDate = addMonths(startDate, termMonths);

  const built = buildVoucher(store, {
    date: startDate,
    type: 'deposit_open',
    memo: options.memo || `存定期：${bankName} ${baseName}`,
    entries: [
      { target: 'account', id: fixed.id, side: 'debit', amount: formatYuan(amountCents) },
      { target: 'account', id: demand.id, side: 'credit', amount: formatYuan(amountCents) },
    ],
  });
  if (!built.ok || built.needsQuestion) return built;

  fixed.meta = {
    ...(fixed.meta || {}),
    fixed_deposit: {
      principalCents: amountCents,
      annualRateBps,
      termMonths,
      startDate,
      maturityDate,
      demandAccountId: demand.id,
      status: 'active',
      interestCents: null,
      closedAt: null,
      openVoucherId: built.voucher.id,
    },
  };
  built.voucher.fixedDepositAccountId = fixed.id;
  postVoucher(store, built.voucher);
  store.saveAccounts();
  store.audit({
    action: 'deposit-open',
    accountId: fixed.id,
    principalCents: amountCents,
    annualRateBps,
    termMonths,
    at: new Date().toISOString(),
  });
  return { ok: true, group, demand, fixed, voucher: built.voucher, maturityDate };
}

export function listFixedDeposits(store) {
  return store.accounts
    .filter((account) => fixedMeta(account))
    .map((account) => {
      const meta = fixedMeta(account);
      return {
        accountId: account.id,
        name: account.name,
        parentId: account.parentId,
        principalCents: meta.principalCents,
        annualRateBps: meta.annualRateBps,
        termMonths: meta.termMonths,
        startDate: meta.startDate,
        maturityDate: meta.maturityDate,
        status: meta.status,
        interestCents: meta.interestCents,
        balanceCents: accountBalanceCents(account, store.vouchers()),
      };
    })
    .sort((a, b) => String(a.maturityDate).localeCompare(String(b.maturityDate)));
}

export function fixedDepositInterestCents(account, asOf = todayInShanghai()) {
  const meta = fixedMeta(account);
  if (!meta || meta.status !== 'active') return 0;
  const end = asOf < meta.maturityDate ? asOf : meta.maturityDate;
  if (end <= meta.startDate) return 0;
  return interestForPeriod(meta.principalCents, meta.annualRateBps, meta.startDate, addDays(end, -1));
}

function closeDeposit(store, account, options, kind) {
  const meta = fixedMeta(account);
  if (!meta) return { ok: false, errors: [{ code: 'NOT_DEPOSIT', message: '这个账户不是定期' }] };
  if (meta.status !== 'active') return { ok: false, errors: [{ code: 'CLOSED', message: '这笔定期已经结束' }] };

  const demand = store.accounts.find((candidate) => candidate.id === meta.demandAccountId);
  if (!demand) return { ok: false, errors: [{ code: 'DEMAND', message: '找不到对应的活期账户' }] };

  const date = options.date || todayInShanghai();
  const principalCents = meta.principalCents;
  const interestCents =
    kind === 'mature'
      ? interestForPeriod(
          principalCents,
          meta.annualRateBps,
          meta.startDate,
          addDays(date < meta.maturityDate ? date : meta.maturityDate, -1),
        )
      : 0;

  const entries = [
    { target: 'account', id: demand.id, side: 'debit', amount: formatYuan(principalCents + interestCents) },
    { target: 'account', id: account.id, side: 'credit', amount: formatYuan(principalCents) },
  ];
  if (interestCents > 0) {
    entries.push({ target: 'category', id: 'inc_other_interest', side: 'credit', amount: formatYuan(interestCents) });
  }

  const built = buildVoucher(store, {
    date,
    type: kind === 'mature' ? 'deposit_maturity' : 'deposit_withdraw',
    memo:
      options.memo ||
      (kind === 'mature' ? `定期到期：${account.name}` : `提前支取：${account.name}`),
    entries,
  });
  if (!built.ok || built.needsQuestion) return built;

  built.voucher.fixedDepositAccountId = account.id;
  postVoucher(store, built.voucher);
  meta.status = kind === 'mature' ? 'matured' : 'withdrawn';
  meta.interestCents = interestCents;
  meta.closedAt = date;
  meta.closeVoucherId = built.voucher.id;
  store.saveAccounts();
  store.audit({
    action: kind === 'mature' ? 'deposit-mature' : 'deposit-withdraw',
    accountId: account.id,
    interestCents,
    at: new Date().toISOString(),
  });
  return { ok: true, account, demand, interestCents, voucher: built.voucher };
}

export function matureFixedDeposit(store, accountId, options = {}) {
  const account = resolveAccount(store.accounts, accountId);
  if (!account) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到定期账户 ${accountId}` }] };
  const meta = fixedMeta(account);
  if (!meta) return { ok: false, errors: [{ code: 'NOT_DEPOSIT', message: '这个账户不是定期' }] };
  const closeDate = options.date || meta.maturityDate;
  if (closeDate < meta.maturityDate) {
    return {
      ok: false,
      errors: [{ code: 'NOT_MATURED', message: `还没到期（${meta.maturityDate}），要提前取请用 withdraw` }],
    };
  }
  return closeDeposit(store, account, { ...options, date: closeDate }, 'mature');
}

export function withdrawFixedDeposit(store, accountId, options = {}) {
  const account = resolveAccount(store.accounts, accountId);
  if (!account) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到定期账户 ${accountId}` }] };
  return closeDeposit(store, account, options, 'withdraw');
}
