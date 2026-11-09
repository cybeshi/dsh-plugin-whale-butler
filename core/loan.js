// 债权：借出去的钱、利息、还款、坏账；还有垫付和报销。
// 往来人员挂在「往来」账户组下面，正数表示“他欠我”。

import { randomUUID } from 'node:crypto';
import { addDays, daysBetween, fullMonthsBetween } from './dates.js';
import { formatYuan, parseAmountToCents, sumCents } from './money.js';
import { accountBalanceCents, ensureChildAccount } from './accounts.js';
import { buildVoucher, postVoucher, todayInShanghai } from './ledger.js';

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** 单利：实际天数 / 当年实际天数，跨年拆分。 */
function simpleInterestCents(principalCents, annualRateBps, from, toInclusive) {
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

export function ensurePersonAccount(store, person) {
  if (!person) throw new Error('要告诉我这是谁');
  return ensureChildAccount(store, '往来', person);
}

export function loanOutstandingPrincipal(loan) {
  return loan.principalCents - sumCents((loan.repayments || []).map((repayment) => repayment.principalCents || 0));
}

export function loanAccruedInterestCents(loan) {
  return sumCents((loan.interestAccruals || []).map((accrual) => accrual.amountCents || 0));
}

export function loanInterestOutstandingCents(loan) {
  return sumCents(
    (loan.interestAccruals || []).map((accrual) =>
      Math.max(0, (accrual.amountCents || 0) - (accrual.paidCents || 0)),
    ),
  );
}

export function previewLoanInterestCents(loan, from, to) {
  if (!from || !to || from > to) return 0;
  const principal = loanOutstandingPrincipal(loan);
  const rules = (loan.interestRules || []).length
    ? loan.interestRules
    : loan.annualRateBps
      ? [{ from: loan.startDate, to: null, annualRateBps: loan.annualRateBps }]
      : [];
  let total = 0;
  for (const rule of rules) {
    const start = from > rule.from ? from : rule.from;
    const end = rule.to && rule.to < to ? rule.to : to;
    if (start <= end) total += simpleInterestCents(principal, rule.annualRateBps, start, end);
  }
  return total;
}

export function loanInterestCents(loan, asOf = todayInShanghai()) {
  const outstanding = loanOutstandingPrincipal(loan);
  const paidInterest = sumCents((loan.repayments || []).map((repayment) => repayment.interestCents || 0));
  if (outstanding <= 0 || !loan.annualRateBps) return Math.max(0, -paidInterest);

  let accrued = 0;
  if (loan.interestType === 'compound') {
    const months = fullMonthsBetween(loan.startDate, asOf);
    let base = outstanding;
    for (let index = 0; index < months; index += 1) {
      const monthly = Math.round((base * loan.annualRateBps) / 10_000 / 12);
      accrued += monthly;
      base += monthly;
    }
  } else {
    const days = Math.max(0, daysBetween(loan.startDate, asOf));
    accrued = Math.round((outstanding * loan.annualRateBps * days) / (10_000 * 365));
  }
  return Math.max(0, accrued - paidInterest);
}

export function createLoan(store, options = {}) {
  const debtor = options.debtor;
  const principalCents = parseAmountToCents(options.principal);
  const startDate = options.startDate || options.date || todayInShanghai();
  const debtorAccount = ensurePersonAccount(store, debtor);

  const built = buildVoucher(store, {
    date: options.date || startDate,
    type: 'loan',
    memo: options.memo || `借给${debtor}`,
    sourceText: options.sourceText,
    entries: [
      { target: 'account', id: debtorAccount.id, side: 'debit', amount: formatYuan(principalCents) },
      { target: 'account', name: options.account, side: 'credit', amount: formatYuan(principalCents) },
    ],
  });
  if (!built.ok) return built;

  const loan = {
    id: `loan_${randomUUID().slice(0, 8)}`,
    debtorAccountId: debtorAccount.id,
    debtorName: debtor,
    principalCents,
    annualRateBps: Math.round(Number(options.ratePercent || 0) * 100),
    interestType: options.interestType === 'compound' ? 'compound' : 'simple',
    interestRules: Array.isArray(options.rateRules)
      ? options.rateRules.map((rule) => ({
          from: rule.from,
          to: rule.to || null,
          annualRateBps: Math.round(Number(rule.ratePercent || 0) * 100),
        }))
      : [],
    interestAccruals: [],
    repaymentPlan: [],
    startDate,
    status: 'active',
    repayments: [],
    createdAt: new Date().toISOString(),
  };

  built.voucher.loanId = loan.id;
  postVoucher(store, built.voucher);
  store.loans.push(loan);
  store.saveLoans();
  return { ok: true, loan, voucher: built.voucher, debtorAccount };
}

export function addLoanInterestRule(store, loanId, options = {}) {
  const loan = store.loans.find((candidate) => candidate.id === loanId);
  if (!loan) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到债权 ${loanId}` }] };
  const from = options.from;
  const to = options.to || null;
  if (!from) return { ok: false, errors: [{ code: 'FROM', message: '要告诉利息从哪天开始' }] };
  if (to && from > to) return { ok: false, errors: [{ code: 'RANGE', message: '开始日期不能晚于结束日期' }] };
  const annualRateBps = Math.round(Number(options.ratePercent || 0) * 100);
  if (annualRateBps <= 0) return { ok: false, errors: [{ code: 'RATE', message: '利率要大于 0' }] };

  loan.interestRules = [...(loan.interestRules || []), { from, to, annualRateBps }].sort((a, b) =>
    String(a.from).localeCompare(String(b.from)),
  );
  store.saveLoans();
  store.audit({
    action: 'loan-interest-rule',
    loanId,
    from,
    to,
    annualRateBps,
    at: new Date().toISOString(),
  });
  return { ok: true, loan, rule: { from, to, annualRateBps } };
}

export function accrueLoanInterest(store, loanId, options = {}) {
  const loan = store.loans.find((candidate) => candidate.id === loanId);
  if (!loan) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到债权 ${loanId}` }] };
  if (loan.status === 'written_off') {
    return { ok: false, errors: [{ code: 'WRITTEN_OFF', message: '这笔已经核销了，不能再计息' }] };
  }

  const from = options.from || loan.startDate;
  const to = options.to || todayInShanghai();
  const amountCents =
    options.amount !== undefined && options.amount !== null
      ? parseAmountToCents(options.amount)
      : previewLoanInterestCents(loan, from, to);
  if (amountCents <= 0) {
    return { ok: false, errors: [{ code: 'EMPTY', message: '算出来利息是 0，先确认利率和期间' }] };
  }

  const date = options.date || to;
  const built = buildVoucher(store, {
    date,
    type: 'loan_interest',
    memo: options.memo || `${loan.debtorName} 的借款利息（${from} 至 ${to}）`,
    entries: [
      { target: 'account', id: loan.debtorAccountId, side: 'debit', amount: formatYuan(amountCents) },
      { target: 'category', id: 'inc_other_interest', side: 'credit', amount: formatYuan(amountCents) },
    ],
  });
  if (!built.ok || built.needsQuestion) return built;

  const accrual = {
    id: `int_${randomUUID().slice(0, 8)}`,
    from,
    to,
    amountCents,
    paidCents: 0,
    date,
    voucherId: built.voucher.id,
    source: options.amount !== undefined && options.amount !== null ? 'manual' : 'rate',
    createdAt: new Date().toISOString(),
  };
  built.voucher.loanId = loan.id;
  built.voucher.interestAccrualId = accrual.id;
  postVoucher(store, built.voucher);
  loan.interestAccruals = [...(loan.interestAccruals || []), accrual];
  store.saveLoans();
  store.audit({
    action: 'loan-interest-accrual',
    loanId,
    accrualId: accrual.id,
    amountCents,
    from,
    to,
    at: new Date().toISOString(),
  });
  return { ok: true, loan, accrual, voucher: built.voucher };
}

export function repayLoan(store, loanId, options = {}) {
  const loan = store.loans.find((candidate) => candidate.id === loanId);
  if (!loan) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到债权 ${loanId}` }] };
  if (loan.status === 'written_off') {
    return { ok: false, errors: [{ code: 'WRITTEN_OFF', message: '这笔已经核销了，不能再还' }] };
  }

  const amountCents = parseAmountToCents(options.amount);
  const date = options.date || todayInShanghai();
  const interestDue = loanInterestOutstandingCents(loan);
  const principalOutstanding = loanOutstandingPrincipal(loan);

  const interestPart = Math.min(amountCents, interestDue);
  const principalPart = Math.min(amountCents - interestPart, principalOutstanding);
  const excess = amountCents - interestPart - principalPart;
  if (excess > 0) {
    return { ok: false, errors: [{ code: 'OVERPAY', message: `还多了 ${formatYuan(excess)}，鲸鲸不敢记` }] };
  }
  if (principalPart <= 0 && interestPart <= 0) {
    return { ok: false, errors: [{ code: 'EMPTY', message: '还款金额要大于 0' }] };
  }

  const entries = [
    { target: 'account', name: options.account, side: 'debit', amount: formatYuan(amountCents) },
    { target: 'account', id: loan.debtorAccountId, side: 'credit', amount: formatYuan(amountCents) },
  ];

  const built = buildVoucher(store, {
    date,
    type: 'loan_repayment',
    memo: `${loan.debtorName} 还款`,
    entries,
  });
  if (!built.ok) return built;

  built.voucher.loanId = loan.id;
  postVoucher(store, built.voucher);
  loan.repayments.push({
    date,
    amountCents,
    principalCents: principalPart,
    interestCents: interestPart,
    voucherId: built.voucher.id,
  });
  let remainingInterest = interestPart;
  for (const accrual of [...(loan.interestAccruals || [])].sort((a, b) => String(a.from).localeCompare(String(b.from)))) {
    if (remainingInterest <= 0) break;
    const unpaid = Math.max(0, (accrual.amountCents || 0) - (accrual.paidCents || 0));
    const applied = Math.min(unpaid, remainingInterest);
    accrual.paidCents = (accrual.paidCents || 0) + applied;
    remainingInterest -= applied;
  }
  if (loanOutstandingPrincipal(loan) <= 0 && loanInterestOutstandingCents(loan) === 0) loan.status = 'repaid';
  store.saveLoans();
  return { ok: true, loan, voucher: built.voucher, principalPart, interestPart };
}

export function writeOffLoan(store, loanId, options = {}) {
  const loan = store.loans.find((candidate) => candidate.id === loanId);
  if (!loan) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到债权 ${loanId}` }] };
  if (loan.status === 'written_off') {
    return { ok: false, errors: [{ code: 'WRITTEN_OFF', message: '这笔已经核销过了' }] };
  }

  const principalOutstanding = loanOutstandingPrincipal(loan);
  if (principalOutstanding <= 0) {
    return { ok: false, errors: [{ code: 'NOTHING', message: '这笔本金已经还清了，不用核销' }] };
  }

  const built = buildVoucher(store, {
    date: options.date || todayInShanghai(),
    type: 'bad_debt',
    memo: options.reason || `${loan.debtorName} 的借款核销`,
    entries: [
      { target: 'category', id: 'exp_baddebt', side: 'debit', amount: formatYuan(principalOutstanding) },
      { target: 'account', id: loan.debtorAccountId, side: 'credit', amount: formatYuan(principalOutstanding) },
    ],
  });
  if (!built.ok) return built;

  built.voucher.loanId = loan.id;
  postVoucher(store, built.voucher);
  loan.status = 'written_off';
  loan.writeOffVoucherId = built.voucher.id;
  loan.writeOffDate = built.voucher.date;
  store.saveLoans();
  return { ok: true, loan, voucher: built.voucher, writtenOffCents: principalOutstanding };
}

export function advanceTo(store, options = {}) {
  const personAccount = ensurePersonAccount(store, options.person);
  const amountCents = parseAmountToCents(options.amount);
  const built = buildVoucher(store, {
    date: options.date || todayInShanghai(),
    type: 'advance',
    memo: options.memo || `垫付给${options.person}`,
    sourceText: options.sourceText,
    entries: [
      { target: 'account', id: personAccount.id, side: 'debit', amount: formatYuan(amountCents) },
      { target: 'account', name: options.account, side: 'credit', amount: formatYuan(amountCents) },
    ],
  });
  if (!built.ok) return built;
  postVoucher(store, built.voucher);
  return { ok: true, voucher: built.voucher, personAccount, amountCents };
}

export function reimburseFrom(store, options = {}) {
  const personAccount = ensurePersonAccount(store, options.person);
  const balanceCents = accountBalanceCents(personAccount, store.vouchers());
  if (balanceCents <= 0) {
    return {
      ok: false,
      errors: [{ code: 'NO_RECEIVABLE', message: `${options.person} 现在不欠你钱，没法报销` }],
    };
  }

  const amountCents = parseAmountToCents(options.amount);
  const entries = [
    { target: 'account', name: options.account, side: 'debit', amount: formatYuan(amountCents) },
    { target: 'account', id: personAccount.id, side: 'credit', amount: formatYuan(balanceCents) },
  ];

  let shortageCents = 0;
  let excessCents = 0;
  if (amountCents < balanceCents) {
    shortageCents = balanceCents - amountCents;
    entries.push({
      target: 'category',
      category: options.category || '差旅',
      side: 'debit',
      amount: formatYuan(shortageCents),
    });
  } else if (amountCents > balanceCents) {
    excessCents = amountCents - balanceCents;
    entries.push({ target: 'category', id: 'inc_other_diff', side: 'credit', amount: formatYuan(excessCents) });
  }

  const built = buildVoucher(store, {
    date: options.date || todayInShanghai(),
    type: 'reimbursement',
    memo: options.memo || `${options.person} 报销`,
    sourceText: options.sourceText,
    entries,
  });
  if (!built.ok) return built;
  postVoucher(store, built.voucher);
  return { ok: true, voucher: built.voucher, personAccount, shortageCents, excessCents, appliedCents: balanceCents };
}
