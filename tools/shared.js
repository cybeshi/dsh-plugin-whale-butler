// 工具层共享：账本目录、输出格式、通用文本、schema、跨领域小工具。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Store } from '../core/store.js';
import { fixVoucher, buildRefundVoucher, buildVoucher, todayInShanghai } from '../core/ledger.js';
import { buildCartVoucher } from '../core/cart.js';
import { postParsedVoucher } from '../core/snap.js';
import {
  balanceTargetCents,
  balancesByAccount,
  createAccount,
  renameAccount,
  resolveAccount,
  setAccountAliases,
  setInitialBalanceTo,
  suggestAccounts,
} from '../core/accounts.js';
import { accountTransactions } from '../core/account-query.js';
import { balanceSheet, monthlyReport } from '../core/report.js';
import {
  balanceMessage,
  errorsMessage,
  fixMessage,
  questionMessage,
  recordMessage,
} from '../core/wording.js';
import { cardMetaText, cardProgress, cardProgressText, setCardPolicy } from '../core/cards.js';
import { investSummary } from '../core/invest.js';
import { buildChartHtml } from '../core/chart.js';
import { formatScaledInteger, formatYuan, parseAmountToCents, parseScaledInteger } from '../core/money.js';
import { resolveAccountReference } from '../core/resolve.js';
import { categoryPath, findCategory } from '../core/categories.js';
import {
  accrueLoanInterest,
  addLoanInterestRule,
  createLoan,
  loanAccruedInterestCents,
  loanInterestOutstandingCents,
  loanOutstandingPrincipal,
  previewLoanInterestCents,
  repayLoan,
} from '../core/loan.js';
import {
  fixedDepositInterestCents,
  listFixedDeposits,
  matureFixedDeposit,
  openFixedDeposit,
  withdrawFixedDeposit,
} from '../core/deposit.js';
import {
  addInitialStock,
  createProduct,
  findProduct,
  inventoryValueCents,
  priceHistory,
  profitReport,
  purchaseStock,
  returnPurchase,
  returnSale,
  sellStock,
  stockReport,
} from '../core/inventory.js';

let workingDirectory = null;

export function setWorkingDirectory(service) {
  workingDirectory = service || null;
}

export async function dataDir(exec) {
  if (process.env.WHALE_BUTLER_DATA) return process.env.WHALE_BUTLER_DATA;
  try {
    if (workingDirectory && exec && exec.agent) {
      const dir = await workingDirectory.ensure(exec.agent, exec.signal);
      return path.join(dir, 'whale-butler');
    }
  } catch {
    // 回退到进程目录；不要因为工作区解析失败挡住记账
  }
  return path.join(process.cwd(), 'whale-butler');
}

export async function openStore(exec) {
  return new Store(await dataDir(exec)).init();
}

export function ensureCouponAccount(store) {
  let group = store.accounts.find((candidate) => candidate.name === '支付宝账户组');
  if (!group) {
    group = createAccount(store.accounts, { name: '支付宝账户组' });
    store.saveAccounts();
    store.audit({
      action: 'create-account',
      accountId: group.id,
      name: group.name,
      at: new Date().toISOString(),
    });
  }
  let account = store.accounts.find((candidate) => candidate.name === '红包券');
  if (account) {
    if (account.parentId !== group.id || account.excludeFromAssets) {
      account.parentId = group.id;
      account.excludeFromAssets = false;
      store.saveAccounts();
    }
    return account;
  }
  account = createAccount(store.accounts, {
    name: '红包券',
    parentId: group.id,
    excludeFromAssets: false,
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
  return account;
}

export function textOutput() {
  return {
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        voucherId: { type: 'string' },
        path: { type: 'string' },
        needsQuestion: { type: 'boolean' },
        error: { type: 'boolean' },
      },
      required: ['text'],
      additionalProperties: true,
    },
    render(_args, value) {
      return [{ type: 'text', text: String(value && value.text ? value.text : '') }];
    },
  };
}

export function describeVoucher(store, voucher, before, extra = []) {
  const after = balancesByAccount(store.accounts, store.vouchers());
  const accountIds = [
    ...new Set(voucher.entries.filter((entry) => entry.target === 'account').map((entry) => entry.id)),
  ];
  const changes = accountIds.map((id) => {
    const account = store.accounts.find((candidate) => candidate.id === id);
    return { name: account ? account.name : id, before: before.get(id) || 0, after: after.get(id) || 0 };
  });
  const uninitialized = accountIds
    .map((id) => store.accounts.find((candidate) => candidate.id === id))
    .filter((account) => account && !account.initialKnown)
    .map((account) => account.name);

  let text = recordMessage(voucher, { balanceChanges: changes, uninitialized });
  if (extra.length) text += '\n' + extra.join('\n');

  const cardLines = [];
  for (const id of accountIds) {
    const account = store.accounts.find((candidate) => candidate.id === id);
    if (!account) continue;
    const progress = cardProgress(store, account);
    if (progress) cardLines.push(cardProgressText(progress));
  }
  if (cardLines.length) text += '\n\n' + cardLines.join('\n');
  return text;
}

export function postBuilt(store, built, before, extra = []) {
  store.appendVoucher(built.voucher);
  return { text: describeVoucher(store, built.voucher, before, extra), voucherId: built.voucher.id };
}

export function monthReportText(store, month) {
  const report = monthlyReport(store, month);
  const lines = [`${month} 账目（${report.count} 笔）`];
  lines.push(
    `支出毛额 ${formatYuan(report.expenseGrossCents)} ｜ 退款调整 ${formatYuan(
      -report.refundAdjustCents,
    )} ｜ 支出净额 ${formatYuan(report.expenseNetCents)}`,
  );
  lines.push(`收入 ${formatYuan(report.incomeCents)} ｜ 净 ${formatYuan(report.netCents)}`);
  if (report.expenseRows.length) {
    lines.push('支出（毛额 / 调整 / 净额）：');
    for (const row of report.expenseRows) {
      lines.push(
        `  ${row.name} ${formatYuan(row.grossCents)} / ${formatYuan(-row.adjustCents)} / ${formatYuan(row.netCents)}`,
      );
    }
  }
  if (report.incomeRows.length) {
    lines.push('收入：');
    for (const [name, cents] of report.incomeRows) lines.push(`  ${name} ${formatYuan(cents)}`);
  }
  return lines.join('\n');
}

/** 金额统一写法：带货币符号和千分位，如 ¥16,003.00、-¥6,318.52。 */
export function formatMoneyText(cents) {
  const sign = cents < 0 ? '-' : '';
  const [whole, fraction] = formatYuan(Math.abs(cents)).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}¥${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

export function accountListText(store) {
  const sheet = balanceSheet(store);
  if (!sheet.rows.length) return '还没有账户～先加一个，比如 工行借记卡。';
  const lines = [];
  for (const row of sheet.rows) {
    const note = row.archived
      ? '（已归档，不计资产）'
      : row.excludeFromAssets
        ? '（不计资产）'
        : row.initialKnown || row.isInvestment
          ? ''
          : '（期初未告知）';
    lines.push(`${row.name} ${formatMoneyText(row.balanceCents)}${note}`);
  }
  lines.push(`资产 ${formatYuan(sheet.assetsCents)} ｜ 欠款 ${formatYuan(sheet.debtsCents)} ｜ 净资产 ${formatYuan(sheet.netCents)}`);
  return lines.join('\n');
}

export function categoryListText(store) {
  const lines = [];
  for (const kind of ['expense', 'income']) {
    lines.push(kind === 'expense' ? '支出类别：' : '收入类别：');
    const rows = store.categories
      .filter((category) => category.kind === kind && !category.hidden)
      .map((category) => ({ category, path: categoryPath(store.categories, category.id) }))
      .sort((a, b) => a.path.localeCompare(b.path, 'zh'));
    for (const row of rows) lines.push(`  ${row.path}`);
  }
  return lines.join('\n');
}

export function investText(store, month) {
  const summary = investSummary(store, month);
  const lines = [`${summary.month} 理财汇总`];
  if (!summary.rows.length) {
    lines.push('还没有投资账户～');
    return lines.join('\n');
  }
  for (const row of summary.rows) {
    const shares = row.sharesScaled !== null ? formatScaledInteger(row.sharesScaled) : '—';
    const nav = row.navScaled !== null ? formatScaledInteger(row.navScaled) : '—';
    lines.push(`  ${row.account.name}：份额 ${shares} ｜ 净值 ${nav} ｜ 市值 ${formatYuan(row.valueCents)}`);
    lines.push(`    成本 ${formatYuan(row.costCents)} ｜ 浮动盈亏 ${formatYuan(row.floatingCents)}`);
  }
  lines.push(`  已实现理财收入 ${formatYuan(summary.realizedCents)}（浮盈不算收入）`);
  lines.push(`  投资收益调整 ${formatYuan(summary.adjustmentsCents)}（不算当期收入）`);
  lines.push(
    `  合计市值 ${formatYuan(summary.totalValueCents)} ｜ 成本 ${formatYuan(
      summary.totalCostCents,
    )} ｜ 浮盈 ${formatYuan(summary.floatingCents)}`,
  );
  return lines.join('\n');
}

export function loanText(store, loanId, asOf) {
  const loan = store.loans.find((candidate) => candidate.id === loanId);
  if (!loan) return `找不到债权 ${loanId}`;
  const lines = [
    `债权 ${loan.id}`,
    `  债务人 ${loan.debtorName} ｜ 本金 ${formatYuan(loan.principalCents)} ｜ 状态 ${loan.status}`,
    `  本金剩 ${formatYuan(loanOutstandingPrincipal(loan))} ｜ 已计提未付利息 ${formatYuan(
      loanInterestOutstandingCents(loan),
    )} ｜ 累计计提 ${formatYuan(loanAccruedInterestCents(loan))}`,
  ];
  if ((loan.interestRules || []).length) {
    lines.push(
      `  利率：${loan.interestRules
        .map(
          (rule) =>
            `${rule.from}${rule.to ? ` 至 ${rule.to}` : ' 起'} ${(rule.annualRateBps / 100).toFixed(2)}%`,
        )
        .join('；')}`,
    );
  } else {
    lines.push('  利率：未约定');
  }
  if ((loan.interestAccruals || []).length) {
    lines.push(
      `  利息记录：${loan.interestAccruals
        .map(
          (accrual) =>
            `${accrual.from}~${accrual.to} ${formatYuan(accrual.amountCents)}${
              accrual.paidCents ? `（已付 ${formatYuan(accrual.paidCents)}）` : '（未付）'
            }`,
        )
        .join('；')}`,
    );
  }
  if (asOf) lines.push(`  截至 ${asOf}`);
  return lines.join('\n');
}

export const entrySchema = {
  type: 'object',
  properties: {
    target: { type: 'string', enum: ['account', 'category'], description: '分录指向账户还是类别' },
    id: { type: 'string', description: '账户/类别的 id；不确定时可以改用 name/account/category' },
    name: { type: 'string', description: '账户或类别的名字' },
    account: { type: 'string', description: '账户名或别名，如 建行1234' },
    category: { type: 'string', description: '类别名，如 食品' },
    side: { type: 'string', enum: ['debit', 'credit'], description: '借=钱到哪去；贷=钱从哪来' },
    amount: { type: 'string', description: '金额，如 11.5 或 11块5' },
  },
  required: ['side', 'amount'],
  additionalProperties: true,
};

export const detailSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '商品名' },
    qty: { type: 'number', description: '数量' },
    unit: { type: 'string', description: '单位，如 瓶、斤' },
    unitPrice: { type: 'string', description: '单价' },
    original: { type: 'string', description: '原价合计' },
    discount: { type: 'string', description: '分摊到的优惠' },
    net: { type: 'string', description: '折后金额' },
    category: { type: 'string', description: '这一行的类别，如 食品' },
  },
  required: ['category'],
  additionalProperties: true,
};

export const voucherSpecSchema = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'YYYY-MM-DD，没说就今天' },
    type: {
      type: 'string',
      description: '单据类型：expense/income/transfer/repayment/refund/advance/reimbursement/bad_debt/installment/installment_payment/annual_fee/loan/loan_repayment/prepaid/amortization/adjustment/compensation',
    },
    memo: { type: 'string' },
    sourceText: { type: 'string', description: '用户原话或截图识别原文' },
    entries: { type: 'array', items: entrySchema },
    details: { type: 'array', items: detailSchema },
    currency: { type: 'string', description: '外币币种，如 USD；人民币不填' },
    originalAmount: { type: 'string', description: '外币原金额，如 100' },
    exchangeRate: { type: 'string', description: '1 外币折人民币的汇率，如 7.2' },
  },
  required: ['entries'],
  additionalProperties: true,
};

export const cartSpecSchema = {
  type: 'object',
  properties: {
    date: { type: 'string' },
    memo: { type: 'string' },
    sourceText: { type: 'string' },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          qty: { type: 'number' },
          unit: { type: 'string' },
          unitPrice: { type: 'string' },
          original: { type: 'string' },
          category: { type: 'string' },
        },
        required: ['category'],
        additionalProperties: true,
      },
    },
    discount: {
      type: 'object',
      properties: {
        total: { type: 'string', description: '摊减型优惠合计' },
        categories: { type: 'array', items: { type: 'string' }, description: '限品类券适用的类别' },
      },
      additionalProperties: true,
    },
    incomeCoupons: {
      type: 'array',
      items: {
        type: 'object',
        properties: { category: { type: 'string' }, amount: { type: 'string' } },
        required: ['category', 'amount'],
      },
      description: '红包、立减这类当钱花的优惠，单独记收入',
    },
    payments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { account: { type: 'string' }, amount: { type: 'string' } },
        required: ['account', 'amount'],
      },
    },
  },
  required: ['lines'],
  additionalProperties: true,
};

export function qtyText(scaled) {
  return formatScaledInteger(scaled, 3);
}

export function stockSummary(store, product) {
  if (!product) return '';
  const state = store.inventory.items[product.id] || { qtyScaled: 0, costCents: 0 };
  return `库存：${product.name} ${qtyText(state.qtyScaled)} ｜ 成本 ${formatYuan(state.costCents)}`;
}

export function inventoryResultText(store, result, kind, before) {
  if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
  if (!result.ok) return { text: errorsMessage(result.errors), error: true };

  if (kind === 'stock_init') {
    return {
      text: [
        '期初库存记好啦～',
        `  ${result.product.name} ${qtyText(result.purchase.qtyScaled)} ｜ 成本 ${formatYuan(result.purchase.totalCostCents)}`,
        stockSummary(store, result.product),
      ].join('\n'),
    };
  }

  const header =
    kind === 'purchase'
      ? `进货记好啦～${result.product ? ` ${result.product.name}` : ''}`
      : kind === 'sale'
        ? `销售记好啦～${result.product ? ` ${result.product.name}` : ''}`
        : kind === 'return_sale'
          ? '客户退货记好啦～'
          : '供应商退货记好啦～';

  const lines = [header];
  lines.push(describeVoucher(store, result.voucher, before, [stockSummary(store, result.product)]));
  if (kind === 'sale') {
    lines.push(
      `  毛利：收入 ${formatYuan(result.sale.revenueCents)} − 成本 ${formatYuan(result.sale.costCents)} = ${formatYuan(
        result.sale.revenueCents - result.sale.costCents,
      )}`,
    );
  }
  return { text: lines.join('\n'), voucherId: result.voucher.id };
}

export function attachForeignMeta(voucher, args) {
  if (!voucher || !args) return;
  if (args.currency || args.originalAmount || args.exchangeRate) {
    voucher.currency = String(args.currency || 'CNY').toUpperCase();
    if (args.originalAmount !== undefined) voucher.originalAmount = String(args.originalAmount);
    if (args.exchangeRate !== undefined) voucher.exchangeRate = String(args.exchangeRate);
  }
}
