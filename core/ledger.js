// 单据构建、校验、入账、修改。
// 一笔账两边：借方＝钱到哪去，贷方＝钱从哪来；两边必须一样。

import { randomUUID } from 'node:crypto';
import { formatYuan, parseAmountToCents, sumCents } from './money.js';
import { findCategory } from './categories.js';
import { isGroupAccount, resolveAccount } from './accounts.js';

export const VOUCHER_TYPES = [
  'expense',
  'income',
  'transfer',
  'repayment',
  'refund',
  'advance',
  'reimbursement',
  'bad_debt',
  'installment',
  'installment_payment',
  'annual_fee',
  'loan',
  'loan_repayment',
  'loan_interest',
  'debt',
  'debt_repayment',
  'debt_interest',
  'prepaid',
  'amortization',
  'purchase',
  'sale',
  'sale_return',
  'purchase_return',
  'daigou_purchase',
  'daigou_sale',
  'stock_adjustment',
  'deposit_open',
  'deposit_maturity',
  'deposit_withdraw',
  'adjustment',
  'opening',
  'compensation',
];

const DIFF_EXPENSE_ID = 'exp_other_diff';
const DIFF_INCOME_ID = 'inc_other_diff';

export function todayInShanghai() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }
}

export function normalizeDate(value) {
  if (!value) return todayInShanghai();
  const text = String(value).trim().replaceAll('/', '-').replaceAll('.', '-');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!match) throw new Error(`日期看不懂：${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new Error(`这个日期不存在：${value}`);
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function makeVoucherId(date) {
  return `v_${date.replaceAll('-', '')}_${randomUUID().slice(0, 8)}`;
}

function positiveCents(raw, index) {
  const cents = parseAmountToCents(raw);
  if (!Number.isInteger(cents) || cents <= 0) throw new Error(`第 ${index + 1} 条分录：金额要大于 0`);
  return cents;
}

function resolveLeg(store, raw, index) {
  const targetType = raw.target || (raw.account ? 'account' : raw.category ? 'category' : null);

  if (targetType === 'account') {
    const key = raw.account ?? raw.id ?? raw.name;
    const account = resolveAccount(store.accounts, key);
    if (!account) throw new Error(`第 ${index + 1} 条分录：没找到账户「${key ?? '空'}」`);
    if (isGroupAccount(store.accounts, account)) {
      throw new Error(`第 ${index + 1} 条分录：账户「${account.name}」是账户组，不能直接记账`);
    }
    return {
      target: 'account',
      id: account.id,
      name: account.name,
      kind: null,
      side: raw.side === 'credit' ? 'credit' : 'debit',
      amountCents: positiveCents(raw.amount, index),
    };
  }

  if (targetType === 'category') {
    const key = raw.category ?? raw.id ?? raw.name;
    const category = findCategory(store.categories, key);
    if (!category) throw new Error(`第 ${index + 1} 条分录：没找到类别「${key ?? '空'}」`);
    return {
      target: 'category',
      id: category.id,
      name: category.name,
      kind: category.kind,
      side: raw.side === 'credit' ? 'credit' : 'debit',
      amountCents: positiveCents(raw.amount, index),
    };
  }

  throw new Error(`第 ${index + 1} 条分录：要写清楚是账户还是类别`);
}

function normalizeDetail(store, raw, index) {
  const category = findCategory(store.categories, raw.category ?? raw.categoryId ?? raw.categoryName);
  if (!category) throw new Error(`明细第 ${index + 1} 行：没找到类别「${raw.category ?? ''}」`);
  if (category.kind !== 'expense') throw new Error(`明细第 ${index + 1} 行：类别「${category.name}」不是支出类别`);

  const qty = raw.qty ?? null;
  const unit = raw.unit ?? null;
  const unitPriceCents =
    raw.unitPrice !== undefined && raw.unitPrice !== null ? parseAmountToCents(raw.unitPrice) : null;
  let originalCents =
    raw.original !== undefined && raw.original !== null ? parseAmountToCents(raw.original) : null;
  const discountCents =
    raw.discount !== undefined && raw.discount !== null ? parseAmountToCents(raw.discount) : 0;
  let netCents = raw.net !== undefined && raw.net !== null ? parseAmountToCents(raw.net) : null;

  if (originalCents === null && qty !== null && unitPriceCents !== null) {
    if (!Number.isFinite(qty)) throw new Error(`明细第 ${index + 1} 行：数量不是数字`);
    originalCents = Math.round(qty * unitPriceCents);
  }
  if (originalCents === null) throw new Error(`明细第 ${index + 1} 行：要有原价`);
  if (netCents === null) netCents = originalCents - discountCents;
  if (netCents < 0) throw new Error(`明细第 ${index + 1} 行：折后金额不能是负数`);
  if (originalCents - discountCents !== netCents) {
    throw new Error(
      `明细第 ${index + 1} 行：原价 ${formatYuan(originalCents)} − 优惠 ${formatYuan(discountCents)} 不等于折后 ${formatYuan(netCents)}`,
    );
  }

  return {
    name: raw.name || `项目${index + 1}`,
    qty,
    unit,
    unitPriceCents,
    originalCents,
    discountCents,
    netCents,
    categoryId: category.id,
    categoryName: category.name,
  };
}

function expenseDebits(entries, { excludeDiff = true } = {}) {
  return entries.filter(
    (entry) =>
      entry.target === 'category' &&
      entry.kind === 'expense' &&
      entry.side === 'debit' &&
      (!excludeDiff || entry.id !== DIFF_EXPENSE_ID),
  );
}

/**
 * 构建一张单据。
 * 返回 { ok:true, voucher } / { ok:false, errors } / { needsQuestion:true, ... }
 */
export function buildVoucher(store, spec = {}) {
  const warnings = [];
  const date = normalizeDate(spec.date);
  const type = spec.type || 'expense';
  if (!VOUCHER_TYPES.includes(type)) throw new Error(`不认识这种单据：${type}`);

  let entries;
  try {
    entries = (spec.entries || []).map((raw, index) => resolveLeg(store, raw, index));
  } catch (error) {
    return { ok: false, errors: [{ code: 'ENTRY', message: error.message }] };
  }
  if (!entries.length) return { ok: false, errors: [{ code: 'EMPTY', message: '一张单至少要有一条分录' }] };

  let details = [];
  if (spec.details && spec.details.length) {
    try {
      details = spec.details.map((raw, index) => normalizeDetail(store, raw, index));
    } catch (error) {
      return { ok: false, errors: [{ code: 'DETAIL', message: error.message }] };
    }
  }

  if (details.length) {
    const detailSum = sumCents(details.map((detail) => detail.netCents));
    const expenseTotal = sumCents(expenseDebits(entries).map((entry) => entry.amountCents));
    if (detailSum > expenseTotal) {
      return {
        needsQuestion: true,
        reason: 'details_exceed',
        diffCents: detailSum - expenseTotal,
        message: `明细加起来 ${formatYuan(detailSum)}，比记的支出 ${formatYuan(expenseTotal)} 还多`,
      };
    }
    if (detailSum < expenseTotal) {
      const other = findCategory(store.categories, '其他支出');
      const diff = expenseTotal - detailSum;
      details.push({
        name: '其他',
        qty: null,
        unit: null,
        unitPriceCents: null,
        originalCents: diff,
        discountCents: 0,
        netCents: diff,
        categoryId: other.id,
        categoryName: other.name,
      });
      warnings.push(`明细少算了 ${formatYuan(diff)}，鲸鲸给补了一行「其他」`);
    }
  }

  let debitCents = sumCents(entries.filter((entry) => entry.side === 'debit').map((entry) => entry.amountCents));
  let creditCents = sumCents(entries.filter((entry) => entry.side === 'credit').map((entry) => entry.amountCents));

  if (debitCents !== creditCents) {
    const diff = debitCents - creditCents;
    const threshold = spec.largeDiffThresholdCents ?? store.meta.config.largeDiffThresholdCents ?? 5000;

    if (spec.allowAutoBalance === false) {
      return {
        ok: false,
        errors: [
          {
            code: 'UNBALANCED',
            message: `两边不平：借 ${formatYuan(debitCents)}，贷 ${formatYuan(creditCents)}，差 ${formatYuan(Math.abs(diff))}`,
          },
        ],
      };
    }

    if (Math.abs(diff) > threshold) {
      return {
        needsQuestion: true,
        reason: 'large_diff',
        diffCents: diff,
        message: `两边差 ${formatYuan(Math.abs(diff))}，超过 ${formatYuan(threshold)} 了`,
      };
    }

    if (diff > 0) {
      const category = findCategory(store.categories, '差额收入');
      entries.push({
        target: 'category',
        id: category.id,
        name: category.name,
        kind: category.kind,
        side: 'credit',
        amountCents: diff,
        auto: true,
      });
      creditCents += diff;
      warnings.push(`两边差 ${formatYuan(diff)}，记成了差额收入`);
    } else {
      const category = findCategory(store.categories, '差额支出');
      entries.push({
        target: 'category',
        id: category.id,
        name: category.name,
        kind: category.kind,
        side: 'debit',
        amountCents: -diff,
        auto: true,
      });
      debitCents += -diff;
      warnings.push(`两边差 ${formatYuan(-diff)}，记成了差额支出`);
    }
  }

  const now = new Date().toISOString();
  const voucher = {
    id: spec.id || makeVoucherId(date),
    date,
    type,
    memo: spec.memo || '',
    sourceText: spec.sourceText || '',
    entries,
    details,
    totals: {
      debitCents,
      creditCents,
      expenseCents: sumCents(expenseDebits(entries, { excludeDiff: false }).map((entry) => entry.amountCents)),
      detailNetCents: sumCents(details.map((detail) => detail.netCents)),
      originalCents: sumCents(details.map((detail) => detail.originalCents)),
      discountCents: sumCents(details.map((detail) => detail.discountCents)),
    },
    warnings,
    status: 'posted',
    revision: spec.revision || 1,
    createdAt: spec.createdAt || now,
    updatedAt: now,
    history: spec.history || [],
  };

  const check = validateVoucher(store, voucher);
  if (!check.ok) return { ok: false, errors: check.errors, warnings: check.warnings };
  voucher.warnings = check.warnings;
  return { ok: true, voucher };
}

export function validateVoucher(store, voucher) {
  const errors = [];
  const warnings = [...(voucher.warnings || [])];
  const entries = voucher.entries || [];

  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0) {
      errors.push({ code: 'AMOUNT', message: `有一条金额不对劲：${entry.amountCents}` });
    }
    if (entry.target === 'account') {
      if (!store.accounts.some((account) => account.id === entry.id)) {
        errors.push({ code: 'ACCOUNT', message: `找不到账户：${entry.name || entry.id}` });
      }
    } else if (entry.target === 'category') {
      const category = store.categories.find((candidate) => candidate.id === entry.id);
      if (!category) {
        errors.push({ code: 'CATEGORY', message: `找不到类别：${entry.name || entry.id}` });
      } else {
        if (category.kind === 'expense' && entry.side !== 'debit') {
          errors.push({ code: 'SIDE', message: `「${category.name}」是支出类别，应该记在借方` });
        }
        if (category.kind === 'income' && entry.side !== 'credit') {
          errors.push({ code: 'SIDE', message: `「${category.name}」是收入类别，应该记在贷方` });
        }
      }
    } else {
      errors.push({ code: 'TARGET', message: '分录要指向账户或类别' });
    }
  }

  const debitCents = sumCents(entries.filter((entry) => entry.side === 'debit').map((entry) => entry.amountCents));
  const creditCents = sumCents(entries.filter((entry) => entry.side === 'credit').map((entry) => entry.amountCents));
  if (debitCents !== creditCents) {
    errors.push({
      code: 'UNBALANCED',
      message: `两边不平：借 ${formatYuan(debitCents)}，贷 ${formatYuan(creditCents)}`,
    });
  }

  if (voucher.type === 'transfer' || voucher.type === 'repayment') {
    if (entries.some((entry) => entry.target === 'category')) {
      errors.push({ code: 'TYPE', message: '转账/还款不能带收入或支出类别' });
    }
  }

  const details = voucher.details || [];
  if (details.length) {
    const detailSum = sumCents(details.map((detail) => detail.netCents));
    const goodsCents = sumCents(expenseDebits(entries).map((entry) => entry.amountCents));
    if (detailSum !== goodsCents) {
      errors.push({
        code: 'DETAIL_SUM',
        message: `明细合计 ${formatYuan(detailSum)} 不等于支出 ${formatYuan(goodsCents)}`,
      });
    }
    for (let index = 0; index < details.length; index += 1) {
      const detail = details[index];
      if (detail.originalCents - detail.discountCents !== detail.netCents) {
        errors.push({ code: 'DETAIL_LINE', message: `明细第 ${index + 1} 行：原价减优惠不等于折后` });
      }
      if (!Number.isSafeInteger(detail.netCents) || detail.netCents < 0) {
        errors.push({ code: 'DETAIL_AMOUNT', message: `明细第 ${index + 1} 行：折后金额不对` });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function postVoucher(store, voucher) {
  return store.appendVoucher(voucher);
}

/**
 * 退款：借 原支付账户，贷 退款收入；挂到原单上，原单不动。
 */
export function buildRefundVoucher(store, options = {}) {
  const originalId = options.originalId;
  if (!originalId) {
    return { ok: false, errors: [{ code: 'REFUND_LINK', message: '退款要关联原单，告诉我原单号' }] };
  }
  const found = store.findVoucher(originalId);
  if (!found) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到原单 ${originalId}` }] };
  if (options.account === undefined || options.amount === undefined) {
    return { ok: false, errors: [{ code: 'REFUND_FIELDS', message: '退款要告诉我「退到哪个账户」和「退了多少」' }] };
  }

  const amountCents = parseAmountToCents(options.amount);
  const spec = {
    date: options.date,
    type: 'refund',
    memo: options.memo || `退款（原单 ${originalId}）`,
    sourceText: options.sourceText,
    entries: [
      { target: 'account', name: options.account, side: 'debit', amount: formatYuan(amountCents) },
      { target: 'category', id: 'inc_other_refund', side: 'credit', amount: formatYuan(amountCents) },
    ],
  };

  const built = buildVoucher(store, spec);
  if (!built.ok || built.needsQuestion) return built;

  const original = found.voucher;
  built.voucher.refundOf = original.id;

  const originalExpenseCents = sumCents(
    (original.entries || [])
      .filter(
        (entry) =>
          entry.target === 'category' &&
          entry.kind === 'expense' &&
          entry.side === 'debit' &&
          entry.id !== DIFF_EXPENSE_ID,
      )
      .map((entry) => entry.amountCents),
  );
  if (originalExpenseCents > 0 && amountCents > originalExpenseCents) {
    built.voucher.warnings = [
      ...(built.voucher.warnings || []),
      `退款 ${formatYuan(amountCents)} 比原单支出 ${formatYuan(originalExpenseCents)} 还多`,
    ];
  }

  return built;
}


function entryToRaw(entry) {
  return { target: entry.target, id: entry.id, side: entry.side, amount: formatYuan(entry.amountCents) };
}

function detailToRaw(detail) {
  return {
    name: detail.name,
    qty: detail.qty ?? undefined,
    unit: detail.unit ?? undefined,
    unitPrice: detail.unitPriceCents !== null && detail.unitPriceCents !== undefined ? formatYuan(detail.unitPriceCents) : undefined,
    original: formatYuan(detail.originalCents),
    discount: formatYuan(detail.discountCents),
    net: formatYuan(detail.netCents),
    category: detail.categoryId,
  };
}

export function fixVoucher(store, id, spec = {}) {
  const found = store.findVoucher(id);
  if (!found) return { ok: false, errors: [{ code: 'NOT_FOUND', message: `找不到单据 ${id}` }] };
  const old = found.voucher;

  const merged = {
    ...spec,
    id: old.id,
    date: spec.date || old.date,
    type: spec.type || old.type,
    memo: spec.memo ?? old.memo,
    sourceText: spec.sourceText ?? old.sourceText,
    entries: spec.entries || (old.entries || []).map(entryToRaw),
    details: spec.details !== undefined ? spec.details : (old.details || []).map(detailToRaw),
    createdAt: old.createdAt,
    revision: (old.revision || 1) + 1,
    history: [
      ...(old.history || []),
      {
        at: new Date().toISOString(),
        revision: old.revision || 1,
        snapshot: {
          date: old.date,
          type: old.type,
          memo: old.memo,
          entries: old.entries,
          details: old.details,
          totals: old.totals,
        },
      },
    ],
  };

  const built = buildVoucher(store, merged);
  if (!built.ok || built.needsQuestion) return built;

  const voucher = built.voucher;
  voucher.revision = merged.revision;
  voucher.history = merged.history;
  voucher.createdAt = old.createdAt;
  voucher.updatedAt = new Date().toISOString();
  for (const key of [
    'sourceImage',
    'parsedText',
    'parser',
    'refundOf',
    'loanId',
    'planId',
    'annualFeeYear',
    'purchaseId',
    'saleId',
    'returnId',
    'inventoryId',
    'currency',
    'originalAmount',
    'exchangeRate',
  ]) {
    if (old[key] !== undefined) voucher[key] = old[key];
  }

  store.replaceVoucher(voucher, old.date);
  store.audit({ action: 'fix', voucherId: id, at: voucher.updatedAt });
  return { ok: true, voucher, before: old };
}
