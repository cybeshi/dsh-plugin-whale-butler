// 应付款与分期、待摊费用。

import { randomUUID } from 'node:crypto';
import { formatYuan, parseAmountToCents } from './money.js';
import { findCategory } from './categories.js';
import { ensureChildAccount } from './accounts.js';
import { buildVoucher, postVoucher, todayInShanghai } from './ledger.js';
import { addMonths } from './dates.js';

function normalizePeriods(value) {
  const periods = Number(value);
  if (!Number.isInteger(periods) || periods <= 0) throw new Error('期数要是大于 0 的整数');
  return periods;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateWithDay(date, day) {
  const [year, month] = String(date).split('-').map(Number);
  const clamped = Math.min(Number(day), daysInMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

function periodDate(plan, period) {
  const override = (plan.overrides || {})[period];
  if (override && override.date) return override.date;
  if (period === 1) return plan.startDate;
  const [year, month, day] = String(plan.startDate).split('-').map(Number);
  const monthIndex = month - 1 + (period - 1);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  const targetDay = plan.amortizationDay || day;
  return dateWithDay(`${targetYear}-${String(targetMonth).padStart(2, '0')}-01`, targetDay);
}

export function createInstallment(store, options = {}) {
  const name = options.name || '分期';
  const totalCents = parseAmountToCents(options.total);
  const periods = normalizePeriods(options.periods);
  const feePerPeriodCents = options.fee !== undefined && options.fee !== null ? parseAmountToCents(options.fee) : 0;

  const category = findCategory(store.categories, options.category || '其他支出');
  if (!category) throw new Error(`没找到类别「${options.category || '其他支出'}」`);
  if (category.kind !== 'expense') throw new Error('分期买的类别要是支出类别');

  const perPeriodCents = Math.floor(totalCents / periods);
  if (perPeriodCents <= 0) throw new Error('每期金额太小了，鲸鲸算不了');

  const liability = ensureChildAccount(store, '应付款', `应付款-${name}`);
  const date = options.date || todayInShanghai();

  const plan = {
    id: `inst_${randomUUID().slice(0, 8)}`,
    kind: 'installment',
    name,
    totalCents,
    periods,
    perPeriodCents,
    feePerPeriodCents,
    categoryId: category.id,
    categoryName: category.name,
    liabilityAccountId: liability.id,
    startDate: date,
    paidPeriods: [],
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  const built = buildVoucher(store, {
    date,
    type: 'installment',
    memo: options.memo || `分期买${name}`,
    sourceText: options.sourceText,
    entries: [
      { target: 'category', id: category.id, side: 'debit', amount: formatYuan(totalCents) },
      { target: 'account', id: liability.id, side: 'credit', amount: formatYuan(totalCents) },
    ],
  });
  if (!built.ok) return built;

  built.voucher.planId = plan.id;
  postVoucher(store, built.voucher);
  store.plans.push(plan);
  store.savePlans();
  return { ok: true, plan, voucher: built.voucher };
}

export function payInstallment(store, planId, options = {}) {
  const plan = store.plans.find((candidate) => candidate.id === planId && candidate.kind === 'installment');
  if (!plan) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到分期 ${planId}` }] };

  const paid = plan.paidPeriods || [];
  const requested = options.period !== undefined ? Number(options.period) : null;
  const period =
    requested ??
    Array.from({ length: plan.periods }, (_, index) => index + 1).find((candidate) => !paid.includes(candidate)) ??
    null;

  if (!period) return { ok: false, errors: [{ code: 'DONE', message: '这单分期已经还完啦' }] };
  if (!Number.isInteger(period) || period < 1 || period > plan.periods) {
    return { ok: false, errors: [{ code: 'PERIOD', message: `期数要在 1 到 ${plan.periods} 之间` }] };
  }
  if (paid.includes(period)) {
    return { ok: false, errors: [{ code: 'PAID', message: `第 ${period} 期已经还过了` }] };
  }

  const principalCents =
    period === plan.periods
      ? plan.totalCents - plan.perPeriodCents * (plan.periods - 1)
      : plan.perPeriodCents;
  const feeCents = plan.feePerPeriodCents || 0;
  const entries = [
    { target: 'account', id: plan.liabilityAccountId, side: 'debit', amount: formatYuan(principalCents) },
  ];
  if (feeCents > 0) {
    entries.push({ target: 'category', id: 'exp_finance', side: 'debit', amount: formatYuan(feeCents) });
  }
  entries.push({ target: 'account', name: options.account, side: 'credit', amount: formatYuan(principalCents + feeCents) });

  const built = buildVoucher(store, {
    date: options.date || todayInShanghai(),
    type: 'installment_payment',
    memo: `${plan.name} 第 ${period} 期`,
    entries,
  });
  if (!built.ok) return built;

  built.voucher.planId = plan.id;
  built.voucher.period = period;
  postVoucher(store, built.voucher);

  plan.paidPeriods = [...paid, period].sort((a, b) => a - b);
  if (plan.paidPeriods.length === plan.periods) plan.status = 'done';
  store.savePlans();
  return { ok: true, plan, voucher: built.voucher, period, principalCents, feeCents };
}

export function createPrepaid(store, options = {}) {
  const name = options.name || '待摊';
  const totalCents = parseAmountToCents(options.total);
  const periods = normalizePeriods(options.periods);
  const startDate = options.startDate;
  if (!startDate) throw new Error('待摊要告诉我从哪天开始');

  const category = findCategory(store.categories, options.category || '其他支出');
  if (!category) throw new Error(`没找到类别「${options.category || '其他支出'}」`);
  if (category.kind !== 'expense') throw new Error('待摊摊销到的类别要是支出类别');

  const perPeriodCents = Math.floor(totalCents / periods);
  if (perPeriodCents <= 0) throw new Error('每期金额太小了，鲸鲸算不了');

  const asset = ensureChildAccount(store, '待摊费用', `待摊-${name}`);
  const plan = {
    id: `pre_${randomUUID().slice(0, 8)}`,
    kind: 'prepaid',
    name,
    totalCents,
    periods,
    perPeriodCents,
    categoryId: category.id,
    categoryName: category.name,
    assetAccountId: asset.id,
    startDate,
    amortizationDay: options.amortizationDay
      ? Number(options.amortizationDay)
      : Number(String(startDate).slice(8, 10)),
    overrides: {},
    amortizedAmounts: {},
    amortizedPeriods: [],
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  const built = buildVoucher(store, {
    date: startDate,
    type: 'prepaid',
    memo: options.memo || `预付${name}`,
    sourceText: options.sourceText,
    entries: [
      { target: 'account', id: asset.id, side: 'debit', amount: formatYuan(totalCents) },
      { target: 'account', name: options.account, side: 'credit', amount: formatYuan(totalCents) },
    ],
  });
  if (!built.ok) return built;

  built.voucher.planId = plan.id;
  postVoucher(store, built.voucher);
  plan.paymentVoucherId = built.voucher.id;
  store.plans.push(plan);
  store.savePlans();
  return { ok: true, plan, voucher: built.voucher };
}

export function amortizePrepaid(store, planId, options = {}) {
  const plan = store.plans.find((candidate) => candidate.id === planId && candidate.kind === 'prepaid');
  if (!plan) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到待摊 ${planId}` }] };

  const through = options.through || todayInShanghai();
  const amortized = plan.amortizedPeriods || [];
  const amounts = plan.amortizedAmounts || {};
  const created = [];
  let remainingCents =
    plan.totalCents - Object.values(amounts).reduce((sum, amount) => sum + (amount || 0), 0);

  for (let period = 1; period <= plan.periods; period += 1) {
    if (amortized.includes(period)) continue;
    const date = periodDate(plan, period);
    if (date > through) break;

    const override = (plan.overrides || {})[period];
    let amountCents;
    if (override && override.amount) {
      amountCents = parseAmountToCents(override.amount);
    } else if (period === plan.periods) {
      amountCents = remainingCents;
    } else {
      amountCents = Math.min(plan.perPeriodCents, remainingCents);
    }
    if (amountCents <= 0) break;

    const built = buildVoucher(store, {
      date,
      type: 'amortization',
      memo: `${plan.name} 第 ${period} 期摊销`,
      entries: [
        { target: 'category', id: plan.categoryId, side: 'debit', amount: formatYuan(amountCents) },
        { target: 'account', id: plan.assetAccountId, side: 'credit', amount: formatYuan(amountCents) },
      ],
    });
    if (!built.ok) return built;

    built.voucher.planId = plan.id;
    built.voucher.period = period;
    postVoucher(store, built.voucher);
    amortized.push(period);
    amounts[period] = amountCents;
    remainingCents -= amountCents;
    created.push(built.voucher);
  }

  plan.amortizedPeriods = amortized.sort((a, b) => a - b);
  plan.amortizedAmounts = amounts;
  if (plan.amortizedPeriods.length === plan.periods) plan.status = 'done';
  store.savePlans();
  return { ok: true, plan, vouchers: created };
}

export function amortizeAllPrepaids(store, through = todayInShanghai()) {
  const results = [];
  for (const plan of store.plans.filter((candidate) => candidate.kind === 'prepaid' && candidate.status === 'active')) {
    const result = amortizePrepaid(store, plan.id, { through });
    if (!result.ok) return result;
    results.push(result);
  }
  return { ok: true, results };
}

export function updatePrepaid(store, planId, options = {}) {
  const plan = store.plans.find((candidate) => candidate.id === planId && candidate.kind === 'prepaid');
  if (!plan) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到待摊 ${planId}` }] };

  const periods = options.periods !== undefined ? normalizePeriods(options.periods) : plan.periods;
  const postedCount = (plan.amortizedPeriods || []).length;
  if (periods < postedCount) {
    return { ok: false, errors: [{ code: 'PERIODS', message: `已经摊销 ${postedCount} 期，期数不能少于它` }] };
  }
  if (options.startDate) plan.startDate = options.startDate;
  if (options.amortizationDay) plan.amortizationDay = Number(options.amortizationDay);
  if (options.category) {
    const category = findCategory(store.categories, options.category);
    if (!category || category.kind !== 'expense') {
      return { ok: false, errors: [{ code: 'CATEGORY', message: `没找到支出类别「${options.category}」` }] };
    }
    plan.categoryId = category.id;
    plan.categoryName = category.name;
  }
  if (options.total !== undefined) plan.totalCents = parseAmountToCents(options.total);
  plan.periods = periods;

  const postedAmount = Object.values(plan.amortizedAmounts || {}).reduce((sum, amount) => sum + (amount || 0), 0);
  const remainingCents = plan.totalCents - postedAmount;
  const remainingPeriods = periods - postedCount;
  plan.perPeriodCents = remainingPeriods > 0 ? Math.max(0, Math.floor(remainingCents / remainingPeriods)) : 0;
  plan.status = remainingPeriods === 0 ? 'done' : 'active';
  store.savePlans();
  store.audit({ action: 'prepaid-update', planId: plan.id, periods, at: new Date().toISOString() });
  return { ok: true, plan };
}

export function findPlan(store, id) {
  return store.plans.find((candidate) => candidate.id === id) || null;
}
