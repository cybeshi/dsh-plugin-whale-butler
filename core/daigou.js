// 代购：帮特定的人买东西，只赚净差额，不建库存。

import { randomUUID } from 'node:crypto';
import { ensurePersonAccount } from './loan.js';
import { findCategory } from './categories.js';
import { buildVoucher, postVoucher, todayInShanghai } from './ledger.js';
import { formatYuan, parseAmountToCents } from './money.js';

function ensureDaigouCategory(store) {
  let category = findCategory(store.categories, '代购收入');
  if (category && category.kind === 'income') return category;
  category = {
    id: `inc_custom_${randomUUID().slice(0, 8)}`,
    name: '代购收入',
    kind: 'income',
    parentId: null,
    system: false,
  };
  store.categories.push(category);
  store.saveCategories();
  return category;
}

export function createDaigou(store, options = {}) {
  const customer = options.customer;
  if (!customer) throw new Error('代购要告诉我帮谁买');
  const costCents = parseAmountToCents(options.cost ?? options.total);
  const amountCents = parseAmountToCents(options.amount);
  if (costCents <= 0 || amountCents <= 0) throw new Error('代购成本和收款都要大于 0');
  if (amountCents < costCents) throw new Error('代购收款不能小于成本；如果亏了，请按普通收支记');
  const profitCents = amountCents - costCents;
  const customerAccount = ensurePersonAccount(store, customer);
  const date = options.date || todayInShanghai();
  const payAccount = options.payAccount || options.account;
  const collectAccount = options.collectAccount || options.account;
  const vouchers = [];

  if (!options.costPaid) {
    const purchase = buildVoucher(store, {
      date,
      type: 'daigou_purchase',
      memo: options.memo || `代购垫付：${customer}`,
      entries: [
        { target: 'account', id: customerAccount.id, side: 'debit', amount: formatYuan(costCents) },
        { target: 'account', name: payAccount, side: 'credit', amount: formatYuan(costCents) },
      ],
    });
    if (!purchase.ok || purchase.needsQuestion) return purchase;
    purchase.voucher.daigouId = options.id || null;
    postVoucher(store, purchase.voucher);
    vouchers.push(purchase.voucher);
  }

  const collect = buildVoucher(store, {
    date,
    type: 'daigou_sale',
    memo: options.memo || `代购：${customer}`,
    entries: [
      { target: 'account', name: collectAccount, side: 'debit', amount: formatYuan(amountCents) },
      { target: 'account', id: customerAccount.id, side: 'credit', amount: formatYuan(costCents) },
      { target: 'category', id: ensureDaigouCategory(store).id, side: 'credit', amount: formatYuan(profitCents) },
    ],
  });
  if (!collect.ok || collect.needsQuestion) return collect;
  postVoucher(store, collect.voucher);
  vouchers.push(collect.voucher);

  const record = {
    id: `dg_${randomUUID().slice(0, 8)}`,
    customerName: customer,
    customerAccountId: customerAccount.id,
    costCents,
    amountCents,
    profitCents,
    date,
    payAccount,
    collectAccount,
    voucherIds: vouchers.map((voucher) => voucher.id),
    createdAt: new Date().toISOString(),
  };
  store.inventory.daigous.push(record);
  store.saveInventory();
  store.audit({
    action: 'daigou',
    daigouId: record.id,
    customer,
    costCents,
    amountCents,
    profitCents,
    at: new Date().toISOString(),
  });
  return { ok: true, record, customerAccount, vouchers };
}

export function listDaigous(store) {
  return [...(store.inventory.daigous || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
