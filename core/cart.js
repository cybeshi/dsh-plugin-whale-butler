// 购物车：录入每件商品，算优惠摊销，再变成一张单据。
// 摊减型优惠只摊商品、不记券本身；收入型优惠（红包）单独记收入。

import { formatYuan, parseAmountToCents, sumCents } from './money.js';
import { findCategory } from './categories.js';
import { buildVoucher } from './ledger.js';

/**
 * 按原价比例摊优惠。
 * 尾差规则固定：每行先向下取整，余下的分全部给原价最大的那行（并列取行号小的）。
 */
export function allocateDiscount(lines, discountCents, eligibleCategoryIds = null) {
  const eligibleIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!eligibleCategoryIds || eligibleCategoryIds.includes(lines[index].categoryId)) {
      eligibleIndexes.push(index);
    }
  }

  const eligibleTotal = sumCents(eligibleIndexes.map((index) => lines[index].originalCents));
  const capped = Math.min(Math.max(discountCents, 0), eligibleTotal);
  const allocations = new Map();
  let assigned = 0;

  if (capped > 0 && eligibleTotal > 0) {
    for (const index of eligibleIndexes) {
      const share = Math.floor((lines[index].originalCents * capped) / eligibleTotal);
      allocations.set(index, share);
      assigned += share;
    }
    const remainder = capped - assigned;
    if (remainder > 0) {
      const largest = eligibleIndexes
        .slice()
        .sort((a, b) => lines[b].originalCents - lines[a].originalCents || a - b)[0];
      allocations.set(largest, (allocations.get(largest) || 0) + remainder);
    }
  }

  return lines.map((line, index) => {
    const discount = allocations.get(index) || 0;
    return { ...line, discountCents: discount, netCents: line.originalCents - discount };
  });
}

export function buildCartVoucher(store, cart = {}) {
  const warnings = [];

  const lines = (cart.lines || []).map((line, index) => {
    const category = findCategory(store.categories, line.category);
    if (!category) throw new Error(`购物车第 ${index + 1} 行：没找到类别「${line.category ?? ''}」`);
    if (category.kind !== 'expense') {
      throw new Error(`购物车第 ${index + 1} 行：类别「${category.name}」不是支出类别`);
    }

    const qty = line.qty ?? null;
    const unitPriceCents = line.unitPrice !== undefined && line.unitPrice !== null ? parseAmountToCents(line.unitPrice) : null;
    let originalCents = line.original !== undefined && line.original !== null ? parseAmountToCents(line.original) : null;
    if (originalCents === null && qty !== null && unitPriceCents !== null) {
      if (!Number.isFinite(qty)) throw new Error(`购物车第 ${index + 1} 行：数量不是数字`);
      originalCents = Math.round(qty * unitPriceCents);
    }
    if (originalCents === null) throw new Error(`购物车第 ${index + 1} 行：要有原价，或者数量×单价`);

    return {
      name: line.name || `商品${index + 1}`,
      qty,
      unit: line.unit ?? null,
      unitPriceCents,
      originalCents,
      categoryId: category.id,
      categoryName: category.name,
    };
  });

  const discountSpec = cart.discount || {};
  const discountTotal = discountSpec.total !== undefined && discountSpec.total !== null ? parseAmountToCents(discountSpec.total) : 0;
  let eligibleIds = null;
  if (discountSpec.categories && discountSpec.categories.length) {
    eligibleIds = discountSpec.categories.map((name) => {
      const category = findCategory(store.categories, name);
      if (!category) throw new Error(`优惠适用类别「${name}」没找到`);
      return category.id;
    });
  }

  const allocated = allocateDiscount(lines, discountTotal, eligibleIds);
  const allocatedTotal = sumCents(allocated.map((line) => line.discountCents));
  if (discountTotal > allocatedTotal) {
    warnings.push(`优惠 ${formatYuan(discountTotal)} 比能摊的 ${formatYuan(allocatedTotal)} 多，超出的没摊`);
  }

  const byCategory = new Map();
  for (const line of allocated) {
    const current = byCategory.get(line.categoryId) || {
      id: line.categoryId,
      name: line.categoryName,
      cents: 0,
    };
    current.cents += line.netCents;
    byCategory.set(line.categoryId, current);
  }

  const entries = [];
  for (const group of byCategory.values()) {
    if (group.cents > 0) {
      entries.push({ target: 'category', id: group.id, side: 'debit', amount: formatYuan(group.cents) });
    }
  }

  for (const coupon of cart.incomeCoupons || []) {
    const category = findCategory(store.categories, coupon.category);
    if (!category) throw new Error(`收入型优惠的类别「${coupon.category}」没找到`);
    if (category.kind !== 'income') throw new Error(`「${category.name}」不是收入类别`);
    entries.push({ target: 'category', id: category.id, side: 'credit', amount: coupon.amount });
  }

  for (const payment of cart.payments || []) {
    entries.push({ target: 'account', name: payment.account, side: 'credit', amount: payment.amount });
  }

  const spec = {
    date: cart.date,
    type: cart.type || 'expense',
    memo: cart.memo,
    sourceText: cart.sourceText,
    entries,
    details: allocated.map((line) => ({
      name: line.name,
      qty: line.qty ?? undefined,
      unit: line.unit ?? undefined,
      unitPrice: line.unitPriceCents !== null ? formatYuan(line.unitPriceCents) : undefined,
      original: formatYuan(line.originalCents),
      discount: formatYuan(line.discountCents),
      net: formatYuan(line.netCents),
      category: line.categoryId,
    })),
  };

  const built = buildVoucher(store, spec);
  if (built.ok && warnings.length) {
    built.voucher.warnings = [...warnings, ...(built.voucher.warnings || [])];
  }
  if (built.ok) built.allocated = allocated;
  return built;
}
