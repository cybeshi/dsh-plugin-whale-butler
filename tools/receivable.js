// receivable 领域工具。

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

export const receivableTools = [
  {
    name: 'whale_receivable',
    description:
      '债权/借出去的钱：默认无还款计划、无利息；用户提了才加利息。支持手动计息、分段年利率、预览、计提、还款（先冲利息后本金，不复利）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'accrue', 'preview', 'rules', 'repay'] },
        debtor: { type: 'string', description: '欠款人，如 张三' },
        principal: { type: 'string', description: '借出本金' },
        account: { type: 'string', description: '出资/收款账户' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        loanId: { type: 'string', description: '债权号' },
        amount: { type: 'string', description: '还款金额；accrue 时可手动指定利息' },
        from: { type: 'string', description: '计息/利率开始日期' },
        to: { type: 'string', description: '计息/利率结束日期' },
        ratePercent: { type: 'string', description: '年利率百分数，如 2.9' },
        memo: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      try {
        if (args.action === 'add') {
          const result = createLoan(store, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [
              `债权记好啦～${args.debtor} 欠 ${formatYuan(result.loan.principalCents)}`,
              '  默认不设还款计划、不计利息；你提了再补。',
              describeVoucher(store, result.voucher, before),
            ].join('\n'),
            voucherId: result.voucher.id,
            loanId: result.loan.id,
          };
        }
        if (args.action === 'list') {
          if (!store.loans.length) return { text: '还没有债权～' };
          return { text: store.loans.map((loan) => loanText(store, loan.id)).join('\n\n') };
        }
        if (args.action === 'preview') {
          const loan = store.loans.find((candidate) => candidate.id === args.loanId);
          if (!loan) return { text: `找不到债权 ${args.loanId}`, error: true };
          const from = args.from || loan.startDate;
          const to = args.to || todayInShanghai();
          return {
            text: `${loan.debtorName} 的利息预览：${from} 至 ${to} = ${formatYuan(
              previewLoanInterestCents(loan, from, to),
            )}（确认后才入账）`,
          };
        }
        if (args.action === 'rules') {
          const result = addLoanInterestRule(store, args.loanId, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: `利率规则记好啦～${result.rule.from}${result.rule.to ? ` 至 ${result.rule.to}` : ' 起'} ${(
              result.rule.annualRateBps / 100
            ).toFixed(2)}%`,
          };
        }
        if (args.action === 'accrue') {
          const result = accrueLoanInterest(store, args.loanId, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [
              `利息计提好啦～${result.loan.debtorName}`,
              `  ${result.accrual.from} 至 ${result.accrual.to} ｜ ${formatYuan(result.accrual.amountCents)}`,
              describeVoucher(store, result.voucher, before),
            ].join('\n'),
            voucherId: result.voucher.id,
            loanId: result.loan.id,
          };
        }
        if (args.action === 'repay') {
          const result = repayLoan(store, args.loanId, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [
              `还款记好啦～${result.loan.debtorName}`,
              `  本金 ${formatYuan(result.principalPart)} ｜ 利息 ${formatYuan(result.interestPart)}`,
              describeVoucher(store, result.voucher, before),
            ].join('\n'),
            voucherId: result.voucher.id,
            loanId: result.loan.id,
          };
        }
      } catch (error) {
        return { text: `鲸鲸出错了：${error.message}`, error: true };
      }
      return { text: `不认识债权操作：${args.action}`, error: true };
    },
  },
];
