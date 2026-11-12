// 报表：余额表、月度收支（含毛额/退款调整/净额）。

import { assetClassLabel, balancesByAccount, inferAssetClass, isGroupAccount } from './accounts.js';
import { sumCents } from './money.js';

export function balanceSheet(store) {
  const vouchers = store.vouchers();
  const balances = balancesByAccount(store.accounts, vouchers);

  const rows = [];
  for (const account of store.accounts) {
    if (account.archived) continue;
    if (isGroupAccount(store.accounts, account)) continue;
    rows.push({
      id: account.id,
      name: account.name,
      balanceCents: balances.get(account.id) || 0,
      initialKnown: Boolean(account.initialKnown),
      excludeFromAssets: Boolean(account.excludeFromAssets),
      isCreditCard: (account.tags || []).includes('credit_card'),
      isInvestment: (account.tags || []).includes('investment'),
      assetClass: inferAssetClass(store.accounts, account),
      tags: account.tags || [],
    });
  }
  rows.sort((a, b) => b.balanceCents - a.balanceCents);

  const counted = rows.filter((row) => !row.excludeFromAssets);
  const assetsCents = sumCents(counted.filter((row) => row.balanceCents > 0).map((row) => row.balanceCents));
  const debtsCents = -sumCents(counted.filter((row) => row.balanceCents < 0).map((row) => row.balanceCents));

  const byClassMap = new Map();
  for (const row of counted) {
    const key = row.assetClass;
    if (!byClassMap.has(key)) {
      byClassMap.set(key, { assetClass: key, label: assetClassLabel(key), assetsCents: 0, debtsCents: 0, count: 0 });
    }
    const bucket = byClassMap.get(key);
    bucket.count += 1;
    if (row.balanceCents > 0) bucket.assetsCents += row.balanceCents;
    if (row.balanceCents < 0) bucket.debtsCents += -row.balanceCents;
  }
  const byClass = [...byClassMap.values()]
    .map((bucket) => ({ ...bucket, netCents: bucket.assetsCents - bucket.debtsCents }))
    .sort((a, b) => Math.abs(b.netCents) - Math.abs(a.netCents));

  return {
    rows,
    byClass,
    assetsCents,
    debtsCents,
    netCents: assetsCents - debtsCents,
    uninitialized: rows
      .filter((row) => !row.initialKnown && !row.excludeFromAssets && !row.isInvestment)
      .map((row) => row.name),
  };
}

/**
 * 退款按原单的支出类别比例分摊，用来算“净额”。
 * 尾差规则和购物车一样：先向下取整，余下的给原价最大的那行。
 */
function allocateRefundToCategories(original, refundCents) {
  const legs = (original.entries || []).filter(
    (entry) =>
      entry.target === 'category' &&
      entry.kind === 'expense' &&
      entry.side === 'debit' &&
      entry.id !== 'exp_other_diff',
  );
  const total = sumCents(legs.map((leg) => leg.amountCents));
  if (!total) return [];

  const capped = Math.min(Math.max(refundCents, 0), total);
  const result = new Map();
  let assigned = 0;

  for (const leg of legs) {
    const share = Math.floor((leg.amountCents * capped) / total);
    result.set(leg.name, (result.get(leg.name) || 0) + share);
    assigned += share;
  }

  const remainder = capped - assigned;
  if (remainder > 0) {
    const largest = legs.slice().sort((a, b) => b.amountCents - a.amountCents)[0];
    result.set(largest.name, (result.get(largest.name) || 0) + remainder);
  }

  return [...result.entries()].map(([name, amountCents]) => ({ name, amountCents }));
}

export function monthlyReport(store, month) {
  const vouchers = store.vouchers(month);
  const expense = new Map();
  const income = new Map();
  const refundAdjust = new Map();
  const categoryById = new Map(store.categories.map((category) => [category.id, category]));

  let refundAdjustCents = 0;
  let unallocatedRefundCents = 0;

  const bump = (map, key, amount) => map.set(key, (map.get(key) || 0) + amount);

  for (const voucher of vouchers) {
    if (voucher.type === 'refund') {
      const refundCents = sumCents(
        (voucher.entries || [])
          .filter((entry) => entry.target === 'category' && entry.kind === 'income' && entry.side === 'credit')
          .map((entry) => entry.amountCents),
      );
      const original = voucher.refundOf ? store.findVoucher(voucher.refundOf)?.voucher : null;
      const allocations = original ? allocateRefundToCategories(original, refundCents) : [];
      if (allocations.length) {
        for (const allocation of allocations) {
          bump(refundAdjust, allocation.name, allocation.amountCents);
          refundAdjustCents += allocation.amountCents;
        }
      } else {
        unallocatedRefundCents += refundCents;
      }
      continue;
    }

    for (const entry of voucher.entries || []) {
      if (entry.target !== 'category') continue;
      const category = categoryById.get(entry.id);
      if (category && category.excludeFromReport) continue;
      if (entry.kind === 'expense' && entry.side === 'debit') bump(expense, entry.name, entry.amountCents);
      if (entry.kind === 'income' && entry.side === 'credit' && entry.id !== 'inc_other_refund') {
        bump(income, entry.name, entry.amountCents);
      }
    }
  }

  const names = new Set([...expense.keys(), ...refundAdjust.keys()]);
  const expenseRows = [...names]
    .map((name) => {
      const grossCents = expense.get(name) || 0;
      const adjustCents = refundAdjust.get(name) || 0;
      return { name, grossCents, adjustCents, netCents: grossCents - adjustCents };
    })
    .sort((a, b) => b.grossCents - a.grossCents || b.adjustCents - a.adjustCents);

  const incomeRows = [...income.entries()].sort((a, b) => b[1] - a[1]);
  const expenseGrossCents = sumCents(expenseRows.map((row) => row.grossCents));
  const expenseNetCents = sumCents(expenseRows.map((row) => row.netCents)) - unallocatedRefundCents;
  const incomeCents = sumCents(incomeRows.map((row) => row[1]));

  return {
    month,
    count: vouchers.length,
    expenseRows,
    incomeRows,
    expenseGrossCents,
    refundAdjustCents: refundAdjustCents + unallocatedRefundCents,
    expenseNetCents,
    incomeCents,
    netCents: incomeCents - expenseNetCents,
    unallocatedRefundCents,
    // 兼容旧字段：这里的“支出”指净额
    expenseCents: expenseNetCents,
  };
}
