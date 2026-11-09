// query 领域工具。

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
import * as shared from './shared.js';

const {
  openStore,
  ensureCouponAccount,
  textOutput,
  describeVoucher,
  postBuilt,
  monthReportText,
  accountListText,
  categoryListText,
  investText,
  loanText,
  entrySchema,
  detailSchema,
  voucherSpecSchema,
  cartSpecSchema,
  qtyText,
  stockSummary,
  inventoryResultText,
  attachForeignMeta,
} = shared;

export const queryTools = [
  {
    name: 'whale_query',
    description:
      '鲸娘管家查询：余额、月报、账户最近流水、信用卡年费进度、理财汇总、债权、分期、待摊、账户列表、类别、库存、经营毛利、商品进价历史。只读，不改账。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'balance',
            'month',
            'card',
            'invest',
            'loan',
            'installments',
            'prepaids',
            'accounts',
            'categories',
            'account',
            'vouchers',
            'stock',
            'profit',
            'price_history',
            'loans',
          ],
        },
        month: { type: 'string', description: 'YYYY-MM' },
        account: { type: 'string', description: '账户名，查流水或年费进度时用' },
        product: { type: 'string', description: '商品名，查进价历史时用' },
        id: { type: 'string', description: '债权号' },
        asOf: { type: 'string', description: '算到哪天，YYYY-MM-DD' },
        limit: { type: 'number', description: '查账户流水时看几笔，默认 5' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const action = args && args.action;
      const month = (args && args.month) || new Date().toISOString().slice(0, 7);
      if (action === 'balance') return { text: balanceMessage(balanceSheet(store)) };
      if (action === 'month') return { text: monthReportText(store, month) };
      if (action === 'accounts') return { text: accountListText(store) };
      if (action === 'categories') return { text: categoryListText(store) };
      if (action === 'account') {
        const account = resolveAccount(store.accounts, args.account);
        if (!account) return { text: `没找到账户「${args.account}」`, error: true };
        const rows = accountTransactions(store, account, args.limit || 5);
        const lines = [`${account.name} 最近 ${rows.length} 笔流水：`];
        for (const row of rows) {
          lines.push(
            `  ${row.date} · ${row.side === 'debit' ? '进' : '出'} ${formatYuan(row.amountCents)} · ${
              row.memo || row.type
            } · ${row.voucherId}`,
          );
        }
        const balance = balancesByAccount(store.accounts, store.vouchers()).get(account.id) || 0;
        lines.push(`  当前余额 ${formatYuan(balance)}`);
        return { text: lines.join('\n') };
      }
      if (action === 'vouchers') {
        const month = args.month || todayInShanghai().slice(0, 7);
        const vouchers = store.vouchers(month).slice(-(args.limit || 20));
        if (!vouchers.length) return { text: `${month} 还没有单据～` };
        return {
          text: [
            `${month} 单据（最近 ${vouchers.length} 张）：`,
            ...vouchers.map(
              (voucher) =>
                `  ${voucher.date} · ${voucher.memo || voucher.type} · ${formatYuan(
                  voucher.totals.debitCents,
                )} · ${voucher.id}`,
            ),
          ].join('\n'),
        };
      }
      if (action === 'stock') {
        const rows = stockReport(store);
        if (!rows.length) return { text: '库存是空的～' };
        const lines = ['库存：'];
        for (const row of rows) {
          lines.push(
            `  ${row.name}${row.spec ? `（${row.spec}）` : ''} ${formatScaledInteger(row.qtyScaled, 3)} ${
              row.unit || ''
            } ｜ 成本 ${formatYuan(row.costCents)} ｜ 均价 ${formatYuan(row.avgCostCents)}`,
          );
        }
        lines.push(`  库存总值 ${formatYuan(inventoryValueCents(store))}`);
        return { text: lines.join('\n') };
      }
      if (action === 'profit') {
        const report = profitReport(store, { month: args.month });
        return {
          text: [
            `${report.month || '全部'} 经营汇总（${report.salesCount} 笔销售）`,
            `  销售收入 ${formatYuan(report.revenueCents)} ｜ 销售退回 ${formatYuan(report.returnCents)} ｜ 净收入 ${formatYuan(
              report.netRevenueCents,
            )}`,
            `  销售成本 ${formatYuan(report.costCents)} ｜ 成本冲回 ${formatYuan(
              report.costReversalCents,
            )} ｜ 净成本 ${formatYuan(report.netCostCents)}`,
            `  毛利 ${formatYuan(report.grossProfitCents)}`,
          ].join('\n'),
        };
      }
      if (action === 'price_history') {
        const product = findProduct(store, args.product || args.account);
        if (!product) return { text: `没找到商品「${args.product}」`, error: true };
        const rows = priceHistory(store, product.id);
        if (!rows.length) return { text: `${product.name} 还没有进货记录～` };
        return {
          text: [
            `${product.name} 进价历史：`,
            ...rows.map(
              (row) =>
                `  ${row.date} · ${formatScaledInteger(row.qtyScaled, 3)} ｜ 总成本 ${formatYuan(
                  row.totalCostCents,
                )} ｜ 单位成本 ${formatYuan(row.unitCostCents)}${row.supplier ? ` ｜ ${row.supplier}` : ''}`,
            ),
          ].join('\n'),
        };
      }
      if (action === 'invest') return { text: investText(store, month) };
      if (action === 'card') {
        const account = resolveAccount(store.accounts, args.account);
        if (!account) return { text: `没找到账户「${args.account}」`, error: true };
        let text = cardMetaText(account);
        const progress = cardProgress(store, account, args.asOf);
        text += '\n' + (progress ? cardProgressText(progress) : '（还没设年费政策，年费进度暂不可用）');
        return { text };
      }
      if (action === 'loan') return { text: loanText(store, args.id, args.asOf) };
      if (action === 'loans') {
        if (!store.loans.length) return { text: '还没有债权～' };
        return {
          text: store.loans
            .map(
              (loan) =>
                `${loan.id} · ${loan.debtorName} · 本金剩 ${formatYuan(
                  loanOutstandingPrincipal(loan),
                )} · ${loan.status}`,
            )
            .join('\n'),
        };
      }
      if (action === 'installments') {
        const plans = store.plans.filter((plan) => plan.kind === 'installment');
        return {
          text: plans.length
            ? plans
                .map(
                  (plan) =>
                    `${plan.id} · ${plan.name} · 已还 ${plan.paidPeriods.length}/${plan.periods} 期 · ${plan.status}`,
                )
                .join('\n')
            : '还没有分期～',
        };
      }
      if (action === 'prepaids') {
        const plans = store.plans.filter((plan) => plan.kind === 'prepaid');
        return {
          text: plans.length
            ? plans
                .map(
                  (plan) =>
                    `${plan.id} · ${plan.name} · 已摊 ${plan.amortizedPeriods.length}/${plan.periods} 期 · ${plan.status}`,
                )
                .join('\n')
            : '还没有待摊～',
        };
      }
      return { text: `不认识的查询：${action}`, error: true };
    },
  },
  {
    name: 'whale_chart',
    description:
      '鲸娘管家生成离线 HTML 图表报表：类目饼图、月度柱状、类目×月堆叠。纯手绘 SVG，无第三方库。只有用户明确要求看报表/图表时才调用；记账、改单之后不要自动刷新，也不要主动问要不要刷新。',
    parameters: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM，默认本月' },
        months: { type: 'number', description: '看近几个月，默认 6' },
        out: { type: 'string', description: '输出文件路径；省略时写到账本目录' },
      },
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const month = (args && args.month) || new Date().toISOString().slice(0, 7);
      const months = (args && args.months) || 6;
      const html = buildChartHtml(store, { month, months });
      const out = args && args.out ? path.resolve(args.out) : path.join(store.dataDir, 'reports', `报告-${month}.html`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, html, 'utf8');
      return { text: `画好啦～🐋\n  ${out}\n  用浏览器打开就能看。`, path: out };
    },
  },
];
