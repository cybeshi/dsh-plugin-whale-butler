// 应付款与分期、待摊费用。

import { randomUUID } from 'node:crypto';
import { formatYuan, parseAmountToCents } from './money.js';
import { findCategory } from './categories.js';
import { ensureChildAccount } from './accounts.js';
import { buildVoucher, fixVoucher, postVoucher, todayInShanghai } from './ledger.js';
import { addDays, addMonths } from './dates.js';

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

// ---- 按天 / 按周期的待摊排期（I-056）----

function monthEndOf(date) {
  const [year, month] = String(date).split('-').map(Number);
  return `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth(year, month)).padStart(2, '0')}`;
}

function addMonthsClamped(date, months) {
  const [year, month, day] = String(date).split('-').map(Number);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

function daysInclusive(from, to) {
  const [y1, m1, d1] = String(from).split('-').map(Number);
  const [y2, m2, d2] = String(to).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

/** 按自然月切：每个自然月一期，金额按覆盖天数分摊，尾差给最后一期。 */
function buildCalendarSchedule(totalCents, start, end) {
  const segments = [];
  let cursor = start;
  while (cursor <= end) {
    const segEnd = monthEndOf(cursor) < end ? monthEndOf(cursor) : end;
    segments.push({ date: segEnd, days: daysInclusive(cursor, segEnd) });
    cursor = addDays(segEnd, 1);
  }
  const totalDays = segments.reduce((sum, item) => sum + item.days, 0);
  let allocated = 0;
  return segments.map((item, index) => {
    const period = index + 1;
    const last = index === segments.length - 1;
    const amountCents = last ? totalCents - allocated : Math.floor((totalCents * item.days) / totalDays);
    allocated += amountCents;
    return { period, date: item.date, days: item.days, amountCents };
  });
}

/** 按账单周期切：每期一个月，整周期等额；最后一个不满的周期按天数折算。 */
function buildCycleSchedule(totalCents, start, end) {
  const segments = [];
  let cursor = start;
  while (cursor <= end) {
    const nextStart = addMonthsClamped(cursor, 1);
    const fullEnd = addDays(nextStart, -1);
    const cappedEnd = fullEnd < end ? fullEnd : end;
    segments.push({
      date: cappedEnd,
      days: daysInclusive(cursor, cappedEnd),
      fullDays: daysInclusive(cursor, fullEnd),
    });
    if (cappedEnd >= end) break;
    cursor = nextStart;
  }
  const weights = segments.map((item) => item.days / item.fullDays);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let allocated = 0;
  return segments.map((item, index) => {
    const period = index + 1;
    const last = index === segments.length - 1;
    const amountCents = last
      ? totalCents - allocated
      : Math.floor((totalCents * weights[index]) / totalWeight);
    allocated += amountCents;
    return { period, date: item.date, amountCents };
  });
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

  const category = findCategory(store.categories, options.category || '其他支出');
  if (!category) throw new Error(`没找到类别「${options.category || '其他支出'}」`);
  if (category.kind !== 'expense') throw new Error('待摊摊销到的类别要是支出类别');

  const coverageStart = options.coverageStart || null;
  const coverageEnd = options.coverageEnd || null;
  if (coverageStart && !coverageEnd) throw new Error('给了开始日期，还要告诉我覆盖到哪天');
  if (coverageEnd && !coverageStart) throw new Error('给了结束日期，还要告诉我从哪天开始');
  if (coverageStart && coverageEnd && coverageEnd < coverageStart) {
    throw new Error('结束日期不能早于开始日期');
  }

  const hasCoverage = Boolean(coverageStart && coverageEnd);
  const explicitMode = options.mode;
  const mode = hasCoverage
    ? explicitMode === 'even'
      ? 'even'
      : explicitMode === 'cycle'
        ? 'cycle'
        : explicitMode === 'calendar'
          ? 'calendar'
          : options.periods
            ? 'even'
            : 'calendar'
    : 'even';

  let periods;
  let perPeriodCents;
  let schedule = null;
  if (mode === 'even') {
    periods = normalizePeriods(options.periods);
    perPeriodCents = Math.floor(totalCents / periods);
  } else {
    if (!hasCoverage) throw new Error('按覆盖期摊要先给覆盖起止日期');
    if (options.periods !== undefined) {
      throw new Error('覆盖期模式的期数由日期算；要固定期数，请用 mode=even');
    }
    schedule =
      mode === 'cycle'
        ? buildCycleSchedule(totalCents, coverageStart, coverageEnd)
        : buildCalendarSchedule(totalCents, coverageStart, coverageEnd);
    periods = schedule.length;
    perPeriodCents = schedule[0] ? schedule[0].amountCents : 0;
  }

  const startDate = options.startDate || coverageStart;
  if (!startDate) throw new Error('待摊要告诉我从哪天开始');
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
    mode,
    paidAt: options.paidAt || startDate,
    coverageStart,
    coverageEnd,
    schedule,
    startDate,
    amortizationDay:
      mode === 'even'
        ? options.amortizationDay
          ? Number(options.amortizationDay)
          : Number(String(startDate).slice(8, 10))
        : null,
    overrides: {},
    amortizedAmounts: {},
    amortizedPeriods: [],
    status: 'active',
    createdAt: new Date().toISOString(),
  };

  const built = buildVoucher(store, {
    date: plan.paidAt,
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

  const post = (period, date, amountCents) => {
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
    created.push(built.voucher);
    return null;
  };

  if (Array.isArray(plan.schedule) && plan.schedule.length) {
    // 按天 / 按周期排好的计划：日期和金额都已经算好，照单摊销。
    for (const item of plan.schedule) {
      if (amortized.includes(item.period)) continue;
      const override = (plan.overrides || {})[item.period] || {};
      const date = override.date || item.date;
      if (date > through) break;
      const amountCents = override.amount ? parseAmountToCents(override.amount) : item.amountCents;
      if (amountCents <= 0) continue;
      const failed = post(item.period, date, amountCents);
      if (failed) return failed;
    }
  } else {
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

      const failed = post(period, date, amountCents);
      if (failed) return failed;
      remainingCents -= amountCents;
    }
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

/** 输出用：给等额计划补出逐期日期/金额；有 schedule 的直接用 schedule。 */
export function previewPrepaidSchedule(plan) {
  if (Array.isArray(plan.schedule) && plan.schedule.length) return plan.schedule;
  const rows = [];
  let allocated = 0;
  for (let period = 1; period <= plan.periods; period += 1) {
    const override = (plan.overrides || {})[period] || {};
    const amountCents = override.amount
      ? parseAmountToCents(override.amount)
      : period === plan.periods
        ? plan.totalCents - allocated
        : plan.perPeriodCents;
    allocated += amountCents;
    rows.push({
      period,
      date: override.date || periodDate(plan, period),
      amountCents,
    });
  }
  return rows;
}

export function updatePrepaid(store, planId, options = {}) {
  const plan = store.plans.find((candidate) => candidate.id === planId && candidate.kind === 'prepaid');
  if (!plan) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到待摊 ${planId}` }] };

  const postedCount = (plan.amortizedPeriods || []).length;
  const snapshot = (candidate) => ({
    mode: candidate.mode,
    coverageStart: candidate.coverageStart,
    coverageEnd: candidate.coverageEnd,
    periods: candidate.periods,
    totalCents: candidate.totalCents,
    paidAt: candidate.paidAt,
    categoryId: candidate.categoryId,
    categoryName: candidate.categoryName,
    assetAccountId: candidate.assetAccountId,
    perPeriodCents: candidate.perPeriodCents,
    schedule: candidate.schedule ? candidate.schedule.map((item) => ({ ...item })) : null,
    overrides: { ...(candidate.overrides || {}) },
  });
  const before = snapshot(plan);
  const beforeOverrideCount = Object.keys(plan.overrides || {}).length;
  let clearedOverrides = 0;
  const auditUpdate = () =>
    store.audit({
      action: 'prepaid-update',
      planId: plan.id,
      before,
      after: snapshot(plan),
      clearedOverrides,
      at: new Date().toISOString(),
    });

  if (options.paidAt && plan.paymentVoucherId) {
    const fixed = fixVoucher(store, plan.paymentVoucherId, { date: options.paidAt });
    if (!fixed.ok) return fixed;
    plan.paidAt = options.paidAt;
  } else if (options.paidAt) {
    plan.paidAt = options.paidAt;
  }
  const hasCoverageChange =
    options.coverageStart !== undefined || options.coverageEnd !== undefined || options.mode !== undefined;
  if (hasCoverageChange) {
    const nextStart = options.coverageStart ?? plan.coverageStart;
    const nextEnd = options.coverageEnd ?? plan.coverageEnd;
    if (!nextStart || !nextEnd) {
      return { ok: false, errors: [{ code: 'COVERAGE', message: '覆盖期要有开始和结束日期' }] };
    }
    if (nextEnd < nextStart) {
      return { ok: false, errors: [{ code: 'COVERAGE', message: '覆盖结束日期不能早于开始日期' }] };
    }
    const nextMode =
      options.mode || (plan.mode === 'even' ? 'calendar' : plan.mode);
    if (!['calendar', 'cycle', 'even'].includes(nextMode)) {
      return { ok: false, errors: [{ code: 'MODE', message: `不认识分摊口径「${nextMode}」` }] };
    }
    plan.coverageStart = nextStart;
    plan.coverageEnd = nextEnd;
    if (nextMode === 'even') {
      if (options.periods !== undefined) plan.periods = normalizePeriods(options.periods);
      plan.amortizationDay = options.amortizationDay
        ? Number(options.amortizationDay)
        : Number(String(nextStart).slice(8, 10));
      plan.mode = 'even';
      plan.schedule = null;
      plan.perPeriodCents = Math.floor(plan.totalCents / plan.periods);
    } else {
      plan.mode = nextMode;
      plan.schedule =
        nextMode === 'cycle'
          ? buildCycleSchedule(plan.totalCents, nextStart, nextEnd)
          : buildCalendarSchedule(plan.totalCents, nextStart, nextEnd);
      plan.periods = plan.schedule.length;
      plan.perPeriodCents = plan.schedule[0] ? plan.schedule[0].amountCents : 0;
      plan.amortizationDay = null;
      plan.overrides = {};
      clearedOverrides = beforeOverrideCount;
    }
  }
  const hasSchedule = Array.isArray(plan.schedule) && plan.schedule.length > 0;
  const reshapeSchedule =
    options.periods !== undefined || options.startDate || options.amortizationDay !== undefined;

  // 按天 / 按周期排好的计划：可以改成“期数等额”；已摊的部分保留，
  // 只重排未来。这样用户不需要新建计划或冲销付款。
  if (hasSchedule && reshapeSchedule) {
    const nextPeriods = options.periods !== undefined ? normalizePeriods(options.periods) : plan.periods;
    if (nextPeriods < postedCount) {
      return { ok: false, errors: [{ code: 'PERIODS', message: `已经摊销 ${postedCount} 期，期数不能少于它` }] };
    }
    plan.mode = 'even';
    plan.startDate = options.startDate || plan.startDate || plan.coverageStart;
    plan.periods = nextPeriods;
    plan.amortizationDay = options.amortizationDay
      ? Number(options.amortizationDay)
      : Number(String(plan.startDate).slice(8, 10));
    plan.schedule = null;
    const postedAmount = Object.values(plan.amortizedAmounts || {}).reduce((sum, amount) => sum + (amount || 0), 0);
    const remainingPeriods = plan.periods - postedCount;
    plan.perPeriodCents =
      remainingPeriods > 0 ? Math.max(0, Math.floor((plan.totalCents - postedAmount) / remainingPeriods)) : 0;
  }

  if (hasSchedule) {
    if (options.total !== undefined && postedCount > 0) {
      return {
        ok: false,
        errors: [{ code: 'POSTED', message: '已经开始摊销了，总金额不能改；只能改类别。' }],
      };
    }
    if (options.category) {
      const category = findCategory(store.categories, options.category);
      if (!category || category.kind !== 'expense') {
        return { ok: false, errors: [{ code: 'CATEGORY', message: `没找到支出类别「${options.category}」` }] };
      }
      plan.categoryId = category.id;
      plan.categoryName = category.name;
    }
    if (options.total !== undefined) {
      plan.totalCents = parseAmountToCents(options.total);
      if (plan.mode === 'even') {
        const postedAmount = Object.values(plan.amortizedAmounts || {}).reduce((sum, amount) => sum + (amount || 0), 0);
        const remainingPeriods = plan.periods - postedCount;
        plan.perPeriodCents =
          remainingPeriods > 0 ? Math.max(0, Math.floor((plan.totalCents - postedAmount) / remainingPeriods)) : 0;
        plan.schedule = null;
      } else {
        plan.schedule =
          plan.mode === 'cycle'
            ? buildCycleSchedule(plan.totalCents, plan.coverageStart, plan.coverageEnd)
            : buildCalendarSchedule(plan.totalCents, plan.coverageStart, plan.coverageEnd);
        plan.periods = plan.schedule.length;
        plan.perPeriodCents = plan.schedule[0] ? plan.schedule[0].amountCents : 0;
      }
    }
    if (options.overrides) plan.overrides = { ...(plan.overrides || {}), ...options.overrides };
    store.savePlans();
    auditUpdate();
    return { ok: true, plan, clearedOverrides };
  }

  const periods = options.periods !== undefined ? normalizePeriods(options.periods) : plan.periods;
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
  if (options.overrides) plan.overrides = { ...(plan.overrides || {}), ...options.overrides };

  const postedAmount = Object.values(plan.amortizedAmounts || {}).reduce((sum, amount) => sum + (amount || 0), 0);
  const remainingCents = plan.totalCents - postedAmount;
  const remainingPeriods = periods - postedCount;
  plan.perPeriodCents = remainingPeriods > 0 ? Math.max(0, Math.floor(remainingCents / remainingPeriods)) : 0;
  plan.status = remainingPeriods === 0 ? 'done' : 'active';
  store.savePlans();
  auditUpdate();
  return { ok: true, plan, clearedOverrides };
}

export function findPlan(store, id) {
  return store.plans.find((candidate) => candidate.id === id) || null;
}
