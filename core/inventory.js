// 进销存：商品、进货、销售、退货、库存、毛利。
// 成本核算用移动加权平均；数量按 1/1000 存整数，金额按分存整数。

import { randomUUID } from 'node:crypto';
import { findCategory } from './categories.js';
import { createAccount, ensureChildAccount, resolveAccount } from './accounts.js';
import { buildVoucher, postVoucher, todayInShanghai } from './ledger.js';
import { formatScaledInteger, formatYuan, parseAmountToCents, parseScaledInteger, sumCents } from './money.js';

function productId() {
  return `p_${randomUUID().slice(0, 8)}`;
}

function createId(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

export function findProduct(store, key) {
  if (key === null || key === undefined || key === '') return null;
  const text = String(key).trim();
  return (
    store.products.find((product) => product.id === text) ||
    store.products.find((product) => product.name === text) ||
    store.products.find((product) => (product.aliases || []).includes(text)) ||
    null
  );
}

export function createProduct(store, options = {}) {
  const name = String(options.name || '').trim();
  if (!name) throw new Error('商品要有个名字');
  const spec = String(options.spec || '').trim();
  const existing = store.products.find(
    (product) => product.name === name && String(product.spec || '') === spec,
  );
  if (existing) return existing;

  const product = {
    id: productId(),
    name,
    brand: String(options.brand || '').trim(),
    spec,
    unit: String(options.unit || '').trim(),
    aliases: [...new Set((options.aliases || []).map((alias) => String(alias).trim()).filter(Boolean))],
    createdAt: new Date().toISOString(),
  };
  store.products.push(product);
  store.saveProducts();
  store.audit({ action: 'create-product', productId: product.id, name: product.name, at: new Date().toISOString() });
  return product;
}

export function ensureProduct(store, options = {}) {
  const key = options.product || options.name || options.productId;
  const found = findProduct(store, key);
  if (found) return found;
  return createProduct(store, {
    name: options.name || key,
    brand: options.brand,
    spec: options.spec,
    unit: options.unit,
  });
}

export function ensureInventoryAccount(store) {
  let account = store.accounts.find((candidate) => candidate.name === '库存商品');
  if (!account) {
    account = createAccount(store.accounts, {
      name: '库存商品',
      tags: ['inventory'],
      initialKnown: true,
      initialBalanceCents: 0,
    });
    store.saveAccounts();
    store.audit({
      action: 'create-account',
      accountId: account.id,
      name: account.name,
      at: new Date().toISOString(),
    });
  }
  return account;
}

function ensureCategory(store, name, kind) {
  const existing = findCategory(store.categories, name);
  if (existing && existing.kind === kind) return existing.id;
  const id = `${kind === 'expense' ? 'exp_custom' : 'inc_custom'}_${randomUUID().slice(0, 8)}`;
  store.categories.push({ id, name, kind, parentId: null, system: false });
  store.saveCategories();
  store.audit({ action: 'create-category', categoryId: id, name, kind, at: new Date().toISOString() });
  return id;
}

function parseQty(raw) {
  const qty = parseScaledInteger(raw, 3);
  if (qty <= 0) throw new Error('数量要大于 0');
  return qty;
}

function stateFor(store, productIdValue) {
  if (!store.inventory.items[productIdValue]) {
    store.inventory.items[productIdValue] = { qtyScaled: 0, costCents: 0 };
  }
  return store.inventory.items[productIdValue];
}

function goodsCost(options, qtyScaled) {
  if (options.total !== undefined && options.total !== null) return parseAmountToCents(options.total);
  if (options.unitPrice !== undefined && options.unitPrice !== null) {
    return Math.round((parseAmountToCents(options.unitPrice) * qtyScaled) / 1000);
  }
  throw new Error('要告诉我总价或单价');
}

export function addInitialStock(store, options = {}) {
  const product = ensureProduct(store, options);
  const qtyScaled = parseQty(options.qty);
  const costCents = options.total !== undefined ? parseAmountToCents(options.total) : goodsCost(options, qtyScaled);
  if (costCents <= 0) throw new Error('初始库存成本要大于 0');

  const account = ensureInventoryAccount(store);
  account.initialBalanceCents = (account.initialBalanceCents || 0) + costCents;
  account.initialKnown = true;
  store.saveAccounts();

  const purchase = {
    id: createId('pur'),
    productId: product.id,
    date: options.date || todayInShanghai(),
    qtyScaled,
    goodsCostCents: costCents,
    freightCents: 0,
    totalCostCents: costCents,
    unitPriceCents: null,
    accountId: account.id,
    supplier: '期初库存',
    voucherId: null,
    initial: true,
    returnedQtyScaled: 0,
    createdAt: new Date().toISOString(),
  };
  store.inventory.purchases.push(purchase);
  const state = stateFor(store, product.id);
  state.qtyScaled += qtyScaled;
  state.costCents += costCents;
  store.saveInventory();
  store.audit({ action: 'stock-init', productId: product.id, qtyScaled, costCents, at: new Date().toISOString() });
  return { ok: true, product, purchase, state };
}

export function purchaseStock(store, options = {}) {
  const product = ensureProduct(store, options);
  const qtyScaled = parseQty(options.qty);
  const goodsCents = goodsCost(options, qtyScaled);
  const freightCents =
    options.freight !== undefined && options.freight !== null ? parseAmountToCents(options.freight) : 0;
  const totalCostCents = goodsCents + freightCents;
  if (totalCostCents <= 0) throw new Error('进货金额要大于 0');

  const account = resolveAccount(store.accounts, options.account);
  if (!account) throw new Error(`没找到付款账户「${options.account}」`);
  const inventoryAccount = ensureInventoryAccount(store);
  const date = options.date || todayInShanghai();

  const purchase = {
    id: createId('pur'),
    productId: product.id,
    date,
    qtyScaled,
    goodsCostCents: goodsCents,
    freightCents,
    totalCostCents,
    unitPriceCents:
      options.unitPrice !== undefined && options.unitPrice !== null
        ? parseAmountToCents(options.unitPrice)
        : null,
    accountId: account.id,
    supplier: options.supplier || '',
    voucherId: null,
    initial: false,
    returnedQtyScaled: 0,
    createdAt: new Date().toISOString(),
  };

  const built = buildVoucher(store, {
    date,
    type: 'purchase',
    memo: options.memo || `进货：${product.name}`,
    sourceText: options.sourceText,
    entries: [
      { target: 'account', id: inventoryAccount.id, side: 'debit', amount: formatYuan(totalCostCents) },
      { target: 'account', id: account.id, side: 'credit', amount: formatYuan(totalCostCents) },
    ],
  });
  if (!built.ok || built.needsQuestion) return built;

  purchase.voucherId = built.voucher.id;
  built.voucher.purchaseId = purchase.id;
  postVoucher(store, built.voucher);

  const state = stateFor(store, product.id);
  state.qtyScaled += qtyScaled;
  state.costCents += totalCostCents;
  store.inventory.purchases.push(purchase);
  store.saveInventory();
  store.audit({
    action: 'purchase',
    purchaseId: purchase.id,
    productId: product.id,
    qtyScaled,
    totalCostCents,
    at: new Date().toISOString(),
  });
  return { ok: true, product, purchase, voucher: built.voucher, state };
}

export function sellStock(store, options = {}) {
  const product = findProduct(store, options.product);
  if (!product) return { ok: false, errors: [{ code: 'PRODUCT', message: `没找到商品「${options.product}」` }] };
  const qtyScaled = parseQty(options.qty);
  const state = stateFor(store, product.id);
  if (qtyScaled > state.qtyScaled) {
    return {
      ok: false,
      errors: [{ code: 'STOCK', message: `库存不够：${product.name} 只剩 ${formatScaledInteger(state.qtyScaled)}` }],
    };
  }

  const revenueCents = goodsCost(options, qtyScaled);
  if (revenueCents <= 0) throw new Error('销售金额要大于 0');
  const cogsCents =
    qtyScaled === state.qtyScaled ? state.costCents : Math.round((state.costCents * qtyScaled) / state.qtyScaled);

  let paymentAccount = null;
  let customerAccount = null;
  if (options.account) {
    paymentAccount = resolveAccount(store.accounts, options.account);
    if (!paymentAccount) throw new Error(`没找到收款账户「${options.account}」`);
  } else if (options.customer) {
    customerAccount = ensureChildAccount(store, '往来', options.customer);
  } else {
    throw new Error('要告诉我收款账户，或者客户（挂应收）');
  }

  const revenueCategory = ensureCategory(store, '销售收入', 'income');
  const costCategory = ensureCategory(store, '销售成本', 'expense');
  const inventoryAccount = ensureInventoryAccount(store);
  const date = options.date || todayInShanghai();

  const sale = {
    id: createId('sal'),
    productId: product.id,
    date,
    qtyScaled,
    revenueCents,
    costCents: cogsCents,
    unitPriceCents:
      options.unitPrice !== undefined && options.unitPrice !== null
        ? parseAmountToCents(options.unitPrice)
        : null,
    paymentAccountId: paymentAccount ? paymentAccount.id : null,
    customerAccountId: customerAccount ? customerAccount.id : null,
    customerName: options.customer || '',
    voucherId: null,
    returnedQtyScaled: 0,
    createdAt: new Date().toISOString(),
  };

  const entries = [
    { target: 'account', id: (paymentAccount || customerAccount).id, side: 'debit', amount: formatYuan(revenueCents) },
    { target: 'category', id: revenueCategory, side: 'credit', amount: formatYuan(revenueCents) },
  ];
  if (cogsCents > 0) {
    entries.push({ target: 'category', id: costCategory, side: 'debit', amount: formatYuan(cogsCents) });
    entries.push({ target: 'account', id: inventoryAccount.id, side: 'credit', amount: formatYuan(cogsCents) });
  }

  const built = buildVoucher(store, {
    date,
    type: 'sale',
    memo: options.memo || `销售：${product.name}`,
    sourceText: options.sourceText,
    entries,
  });
  if (!built.ok || built.needsQuestion) return built;

  sale.voucherId = built.voucher.id;
  built.voucher.saleId = sale.id;
  postVoucher(store, built.voucher);

  state.qtyScaled -= qtyScaled;
  state.costCents -= cogsCents;
  if (state.qtyScaled <= 0) {
    state.qtyScaled = 0;
    state.costCents = 0;
  }
  store.inventory.sales.push(sale);
  store.saveInventory();
  store.audit({
    action: 'sale',
    saleId: sale.id,
    productId: product.id,
    qtyScaled,
    revenueCents,
    costCents: cogsCents,
    at: new Date().toISOString(),
  });
  return { ok: true, product, sale, voucher: built.voucher, state };
}

export function returnSale(store, options = {}) {
  const sale = store.inventory.sales.find((candidate) => candidate.id === options.saleId);
  if (!sale) return { ok: false, errors: [{ code: 'SALE', message: `找不到销售单 ${options.saleId}` }] };
  const product = store.products.find((candidate) => candidate.id === sale.productId);
  const qtyScaled = parseQty(options.qty);
  const remaining = sale.qtyScaled - (sale.returnedQtyScaled || 0);
  if (qtyScaled > remaining) {
    return { ok: false, errors: [{ code: 'RETURN_QTY', message: `这次最多只能退 ${formatScaledInteger(remaining)}` }] };
  }

  const refundCents = options.refund !== undefined && options.refund !== null ? parseAmountToCents(options.refund) : 0;
  const restock = options.restock !== false;
  const costPortionCents = restock
    ? qtyScaled === sale.qtyScaled
      ? sale.costCents
      : Math.round((sale.costCents * qtyScaled) / sale.qtyScaled)
    : 0;
  const account = resolveAccount(store.accounts, options.account);
  if (!account) throw new Error(`没找到退款账户「${options.account}」`);
  const inventoryAccount = ensureInventoryAccount(store);
  const returnCategory = ensureCategory(store, '销售退回', 'expense');
  const reversalCategory = ensureCategory(store, '销售成本冲回', 'income');
  const date = options.date || todayInShanghai();

  const returnRecord = {
    id: createId('ret'),
    kind: 'sale',
    saleId: sale.id,
    productId: sale.productId,
    date,
    qtyScaled,
    refundCents,
    costPortionCents,
    restock,
    accountId: account.id,
    voucherId: null,
    createdAt: new Date().toISOString(),
  };

  const entries = [];
  if (refundCents > 0) {
    entries.push({ target: 'category', id: returnCategory, side: 'debit', amount: formatYuan(refundCents) });
    entries.push({ target: 'account', id: account.id, side: 'credit', amount: formatYuan(refundCents) });
  }
  if (restock && costPortionCents > 0) {
    entries.push({ target: 'account', id: inventoryAccount.id, side: 'debit', amount: formatYuan(costPortionCents) });
    entries.push({ target: 'category', id: reversalCategory, side: 'credit', amount: formatYuan(costPortionCents) });
  }
  if (!entries.length) throw new Error('退款金额和回库成本不能都是 0');

  const built = buildVoucher(store, {
    date,
    type: 'sale_return',
    memo: options.memo || `客户退货：${product ? product.name : sale.productId}`,
    entries,
  });
  if (!built.ok || built.needsQuestion) return built;

  returnRecord.voucherId = built.voucher.id;
  built.voucher.returnId = returnRecord.id;
  postVoucher(store, built.voucher);

  sale.returnedQtyScaled = (sale.returnedQtyScaled || 0) + qtyScaled;
  if (restock && costPortionCents > 0) {
    const state = stateFor(store, sale.productId);
    state.qtyScaled += qtyScaled;
    state.costCents += costPortionCents;
  }
  store.inventory.returns.push(returnRecord);
  store.saveInventory();
  store.audit({
    action: 'return-sale',
    returnId: returnRecord.id,
    saleId: sale.id,
    qtyScaled,
    refundCents,
    at: new Date().toISOString(),
  });
  return { ok: true, product, sale, returnRecord, voucher: built.voucher };
}

export function returnPurchase(store, options = {}) {
  const purchase = store.inventory.purchases.find((candidate) => candidate.id === options.purchaseId);
  if (!purchase) return { ok: false, errors: [{ code: 'PURCHASE', message: `找不到进货单 ${options.purchaseId}` }] };
  const product = store.products.find((candidate) => candidate.id === purchase.productId);
  const qtyScaled = parseQty(options.qty);
  const remaining = purchase.qtyScaled - (purchase.returnedQtyScaled || 0);
  if (qtyScaled > remaining) {
    return { ok: false, errors: [{ code: 'RETURN_QTY', message: `这次最多只能退 ${formatScaledInteger(remaining)}` }] };
  }

  const refundCents = options.refund !== undefined && options.refund !== null ? parseAmountToCents(options.refund) : 0;
  const costPortionCents =
    qtyScaled === purchase.qtyScaled
      ? purchase.totalCostCents
      : Math.round((purchase.totalCostCents * qtyScaled) / purchase.qtyScaled);
  const account = resolveAccount(store.accounts, options.account);
  if (!account) throw new Error(`没找到退款账户「${options.account}」`);
  const inventoryAccount = ensureInventoryAccount(store);
  const lossCategory = ensureCategory(store, '退货损失', 'expense');
  const gainCategory = ensureCategory(store, '退货收益', 'income');
  const date = options.date || todayInShanghai();

  const returnRecord = {
    id: createId('ret'),
    kind: 'purchase',
    purchaseId: purchase.id,
    productId: purchase.productId,
    date,
    qtyScaled,
    refundCents,
    costPortionCents,
    restock: false,
    accountId: account.id,
    voucherId: null,
    createdAt: new Date().toISOString(),
  };

  const entries = [];
  if (refundCents > 0) {
    entries.push({ target: 'account', id: account.id, side: 'debit', amount: formatYuan(refundCents) });
  }
  entries.push({ target: 'account', id: inventoryAccount.id, side: 'credit', amount: formatYuan(costPortionCents) });
  const difference = costPortionCents - refundCents;
  if (difference > 0) {
    entries.push({ target: 'category', id: lossCategory, side: 'debit', amount: formatYuan(difference) });
  } else if (difference < 0) {
    entries.push({ target: 'category', id: gainCategory, side: 'credit', amount: formatYuan(-difference) });
  }

  const built = buildVoucher(store, {
    date,
    type: 'purchase_return',
    memo: options.memo || `供应商退货：${product ? product.name : purchase.productId}`,
    entries,
  });
  if (!built.ok || built.needsQuestion) return built;

  returnRecord.voucherId = built.voucher.id;
  built.voucher.returnId = returnRecord.id;
  postVoucher(store, built.voucher);

  purchase.returnedQtyScaled = (purchase.returnedQtyScaled || 0) + qtyScaled;
  const state = stateFor(store, purchase.productId);
  state.qtyScaled -= qtyScaled;
  state.costCents -= costPortionCents;
  if (state.qtyScaled <= 0) {
    state.qtyScaled = 0;
    state.costCents = 0;
  }
  store.inventory.returns.push(returnRecord);
  store.saveInventory();
  store.audit({
    action: 'return-purchase',
    returnId: returnRecord.id,
    purchaseId: purchase.id,
    qtyScaled,
    refundCents,
    at: new Date().toISOString(),
  });
  return { ok: true, product, purchase, returnRecord, voucher: built.voucher };
}

export function stockReport(store) {
  const rows = [];
  for (const [productIdValue, state] of Object.entries(store.inventory.items || {})) {
    if (!state || state.qtyScaled <= 0) continue;
    const product = store.products.find((candidate) => candidate.id === productIdValue);
    rows.push({
      productId: productIdValue,
      name: product ? product.name : productIdValue,
      spec: product ? product.spec : '',
      unit: product ? product.unit : '',
      qtyScaled: state.qtyScaled,
      costCents: state.costCents,
      avgCostCents: Math.round((state.costCents * 1000) / state.qtyScaled),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return rows;
}

export function inventoryValueCents(store) {
  return sumCents(Object.values(store.inventory.items || {}).map((state) => state.costCents || 0));
}

export function profitReport(store, options = {}) {
  const month = options.month || null;
  const inRange = (date) => !month || String(date).slice(0, 7) === month;
  const sales = (store.inventory.sales || []).filter((sale) => inRange(sale.date));
  const returns = (store.inventory.returns || []).filter(
    (record) => record.kind === 'sale' && inRange(record.date),
  );
  const revenueCents = sumCents(sales.map((sale) => sale.revenueCents));
  const costCents = sumCents(sales.map((sale) => sale.costCents));
  const returnCents = sumCents(returns.map((record) => record.refundCents));
  const costReversalCents = sumCents(returns.map((record) => record.costPortionCents));
  const netRevenueCents = revenueCents - returnCents;
  const netCostCents = costCents - costReversalCents;
  return {
    month,
    salesCount: sales.length,
    revenueCents,
    returnCents,
    netRevenueCents,
    costCents,
    costReversalCents,
    netCostCents,
    grossProfitCents: netRevenueCents - netCostCents,
    returns,
  };
}

export function priceHistory(store, productIdValue) {
  return (store.inventory.purchases || [])
    .filter((purchase) => purchase.productId === productIdValue)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((purchase) => ({
      id: purchase.id,
      date: purchase.date,
      qtyScaled: purchase.qtyScaled,
      totalCostCents: purchase.totalCostCents,
      unitCostCents: purchase.qtyScaled > 0 ? Math.round((purchase.totalCostCents * 1000) / purchase.qtyScaled) : 0,
      supplier: purchase.supplier || '',
      voucherId: purchase.voucherId,
    }));
}
