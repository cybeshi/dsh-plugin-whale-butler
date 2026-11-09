// 债务：我欠别人的钱。底层和债权共用「往来」账户，只是方向相反。
// 默认无还款计划、无利息；用户提了才加。

import { randomUUID } from 'node:crypto';
import { formatYuan, parseAmountToCents, sumCents } from './money.js';
import { ensurePersonAccount } from './loan.js';
import { buildVoucher, postVoucher, todayInShanghai } from './ledger.js';
import { previewLoanInterestCents } from './loan.js';

export function debtOutstandingPrincipal(debt) {
  return debt.principalCents - sumCents((debt.repayments || []).map((repayment) => repayment.principalCents || 0));
}

export function debtInterestOutstandingCents(debt) {
  return sumCents(
    (debt.interestAccruals || []).map((accrual) =>
      Math.max(0, (accrual.amountCents || 0) - (accrual.paidCents || 0)),
    ),
  );
}

export function createDebt(store, options = {}) {
  const creditor = options.creditor;
  if (!creditor) throw new Error('要告诉我是欠谁的');
  const principalCents = parseAmountToCents(options.principal);
  if (principalCents <= 0) throw new Error('欠款本金要大于 0');
  const startDate = options.startDate || options.date || todayInShanghai();
  const creditorAccount = ensurePersonAccount(store, creditor);

  const debt = {
    id: `debt_${randomUUID().slice(0, 8)}`,
    creditorAccountId: creditorAccount.id,
    creditorName: creditor,
    principalCents,
    annualRateBps: 0,
    interestRules: [],
    interestAccruals: [],
    startDate,
    status: 'active',
    opening: Boolean(options.opening),
    repayments: [],
    createdAt: new Date().toISOString(),
  };

  if (options.opening) {
    creditorAccount.initialBalanceCents = (creditorAccount.initialBalanceCents || 0) - principalCents;
    creditorAccount.initialKnown = true;
    store.saveAccounts();
    store.debts.push(debt);
    store.saveDebts();
    store.audit({
      action: 'debt-opening',
      debtId: debt.id,
      creditorAccountId: creditorAccount.id,
      principalCents,
      at: new Date().toISOString(),
    });
    return { ok: true, debt, creditorAccount, opening: true };
  }

  const built = buildVoucher(store, {
    date: options.date || startDate,
    type: 'debt',
    memo: options.memo || `向${creditor}借入`,
    sourceText: options.sourceText,
    entries: [
      { target: 'account', name: options.account, side: 'debit', amount: formatYuan(principalCents) },
      { target: 'account', id: creditorAccount.id, side: 'credit', amount: formatYuan(principalCents) },
    ],
  });
  if (!built.ok || built.needsQuestion) return built;

  built.voucher.debtId = debt.id;
  postVoucher(store, built.voucher);
  debt.borrowVoucherId = built.voucher.id;
  store.debts.push(debt);
  store.saveDebts();
  store.audit({ action: 'debt-borrow', debtId: debt.id, principalCents, at: new Date().toISOString() });
  return { ok: true, debt, creditorAccount, voucher: built.voucher };
}

export function addDebtInterestRule(store, debtId, options = {}) {
  const debt = store.debts.find((candidate) => candidate.id === debtId);
  if (!debt) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到债务 ${debtId}` }] };
  const from = options.from;
  const to = options.to || null;
  if (!from) return { ok: false, errors: [{ code: 'FROM', message: '要告诉利息从哪天开始' }] };
  if (to && from > to) return { ok: false, errors: [{ code: 'RANGE', message: '开始日期不能晚于结束日期' }] };
  const annualRateBps = Math.round(Number(options.ratePercent || 0) * 100);
  if (annualRateBps <= 0) return { ok: false, errors: [{ code: 'RATE', message: '利率要大于 0' }] };

  debt.interestRules = [...(debt.interestRules || []), { from, to, annualRateBps }].sort((a, b) =>
    String(a.from).localeCompare(String(b.from)),
  );
  store.saveDebts();
  store.audit({ action: 'debt-interest-rule', debtId, from, to, annualRateBps, at: new Date().toISOString() });
  return { ok: true, debt, rule: { from, to, annualRateBps } };
}

export function accrueDebtInterest(store, debtId, options = {}) {
  const debt = store.debts.find((candidate) => candidate.id === debtId);
  if (!debt) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到债务 ${debtId}` }] };
  const from = options.from || debt.startDate;
  const to = options.to || todayInShanghai();
  const amountCents =
    options.amount !== undefined && options.amount !== null
      ? parseAmountToCents(options.amount)
      : previewLoanInterestCents(debt, from, to);
  if (amountCents <= 0) {
    return { ok: false, errors: [{ code: 'EMPTY', message: '算出来利息是 0，先确认利率和期间' }] };
  }

  const built = buildVoucher(store, {
    date: options.date || to,
    type: 'debt_interest',
    memo: options.memo || `${debt.creditorName} 的借款利息（${from} 至 ${to}）`,
    entries: [
      { target: 'category', id: 'exp_interest', side: 'debit', amount: formatYuan(amountCents) },
      { target: 'account', id: debt.creditorAccountId, side: 'credit', amount: formatYuan(amountCents) },
    ],
  });
  if (!built.ok || built.needsQuestion) return built;

  const accrual = {
    id: `dint_${randomUUID().slice(0, 8)}`,
    from,
    to,
    amountCents,
    paidCents: 0,
    date: options.date || to,
    voucherId: built.voucher.id,
    source: options.amount !== undefined && options.amount !== null ? 'manual' : 'rate',
    createdAt: new Date().toISOString(),
  };
  built.voucher.debtId = debt.id;
  built.voucher.interestAccrualId = accrual.id;
  postVoucher(store, built.voucher);
  debt.interestAccruals = [...(debt.interestAccruals || []), accrual];
  store.saveDebts();
  store.audit({ action: 'debt-interest-accrual', debtId, accrualId: accrual.id, amountCents, at: new Date().toISOString() });
  return { ok: true, debt, accrual, voucher: built.voucher };
}

export function repayDebt(store, debtId, options = {}) {
  const debt = store.debts.find((candidate) => candidate.id === debtId);
  if (!debt) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到债务 ${debtId}` }] };
  const amountCents = parseAmountToCents(options.amount);
  const date = options.date || todayInShanghai();
  const interestDue = debtInterestOutstandingCents(debt);
  const principalOutstanding = debtOutstandingPrincipal(debt);
  const interestPart = Math.min(amountCents, interestDue);
  const principalPart = Math.min(amountCents - interestPart, principalOutstanding);
  const excess = amountCents - interestPart - principalPart;
  if (excess > 0) return { ok: false, errors: [{ code: 'OVERPAY', message: `还多了 ${formatYuan(excess)}` }] };
  if (amountCents <= 0) return { ok: false, errors: [{ code: 'EMPTY', message: '还款金额要大于 0' }] };

  const built = buildVoucher(store, {
    date,
    type: 'debt_repayment',
    memo: options.memo || `还${debt.creditorName}的钱`,
    entries: [
      { target: 'account', id: debt.creditorAccountId, side: 'debit', amount: formatYuan(amountCents) },
      { target: 'account', name: options.account, side: 'credit', amount: formatYuan(amountCents) },
    ],
  });
  if (!built.ok || built.needsQuestion) return built;

  built.voucher.debtId = debt.id;
  postVoucher(store, built.voucher);
  debt.repayments.push({ date, amountCents, principalCents: principalPart, interestCents: interestPart, voucherId: built.voucher.id });
  let remainingInterest = interestPart;
  for (const accrual of [...(debt.interestAccruals || [])].sort((a, b) => String(a.from).localeCompare(String(b.from)))) {
    if (remainingInterest <= 0) break;
    const unpaid = Math.max(0, (accrual.amountCents || 0) - (accrual.paidCents || 0));
    const applied = Math.min(unpaid, remainingInterest);
    accrual.paidCents = (accrual.paidCents || 0) + applied;
    remainingInterest -= applied;
  }
  if (debtOutstandingPrincipal(debt) <= 0 && debtInterestOutstandingCents(debt) === 0) debt.status = 'repaid';
  store.saveDebts();
  store.audit({ action: 'debt-repay', debtId, amountCents, interestPart, principalPart, at: new Date().toISOString() });
  return { ok: true, debt, voucher: built.voucher, interestPart, principalPart };
}

export function debtPreviewCents(debt, from, to) {
  return previewLoanInterestCents(debt, from, to);
}
