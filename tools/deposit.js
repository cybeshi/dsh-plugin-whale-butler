// deposit 领域工具。

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

export const depositTools = [
  {
    name: 'whale_deposit',
    description:
      '定期存款：在借记卡账户组下开活期/定期，存入、查看、到期转回活期、提前支取；利息按实际天数/当年实际天数单利。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'list', 'mature', 'withdraw'] },
        bank: { type: 'string', description: '借记卡/银行名，作为账户组，如 民生银行卡' },
        demand: { type: 'string', description: '活期子账户名，默认 <银行>活期' },
        amount: { type: 'string', description: '定期金额' },
        termMonths: { type: 'number', description: '期限（月），如 36' },
        ratePercent: { type: 'string', description: '年利率百分数，如 1.75' },
        date: { type: 'string', description: '起息日/操作日，YYYY-MM-DD' },
        accountId: { type: 'string', description: '定期账户名或 id；到期/支取时用' },
        name: { type: 'string', description: '定期账户名，默认 定期1、定期2...' },
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
        if (args.action === 'open') {
          const result = openFixedDeposit(store, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [
              `定期存好啦～${args.bank} / ${result.fixed.name}`,
              `  本金 ${formatYuan(result.fixed.meta.fixed_deposit.principalCents)} ｜ 年利率 ${(
                result.fixed.meta.fixed_deposit.annualRateBps / 100
              ).toFixed(2)}% ｜ ${result.fixed.meta.fixed_deposit.termMonths} 个月`,
              `  起息 ${result.fixed.meta.fixed_deposit.startDate} ｜ 到期 ${result.maturityDate}`,
              describeVoucher(store, result.voucher, before),
            ].join('\n'),
            voucherId: result.voucher.id,
          };
        }
        if (args.action === 'list') {
          const rows = listFixedDeposits(store);
          if (!rows.length) return { text: '还没有定期存款～' };
          return {
            text: [
              '定期存款：',
              ...rows.map((row) => {
                const account = store.accounts.find((candidate) => candidate.id === row.accountId);
                const interest = account ? fixedDepositInterestCents(account) : 0;
                return `  ${row.name} ｜ 本金 ${formatYuan(row.principalCents)} ｜ 利率 ${(
                  row.annualRateBps / 100
                ).toFixed(2)}% ｜ ${row.startDate} → ${row.maturityDate} ｜ 当前利息 ${formatYuan(
                  interest,
                )} ｜ ${row.status}`;
              }),
            ].join('\n'),
          };
        }
        if (args.action === 'mature') {
          const result = matureFixedDeposit(store, args.accountId, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [
              `定期到期啦～${result.account.name}`,
              `  本金 ${formatYuan(result.account.meta.fixed_deposit.principalCents)} ｜ 利息 ${formatYuan(
                result.interestCents,
              )}`,
              describeVoucher(store, result.voucher, before),
            ].join('\n'),
            voucherId: result.voucher.id,
          };
        }
        if (args.action === 'withdraw') {
          const result = withdrawFixedDeposit(store, args.accountId, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [`提前支取啦～${result.account.name}`, describeVoucher(store, result.voucher, before)].join(
              '\n',
            ),
            voucherId: result.voucher.id,
          };
        }
      } catch (error) {
        return { text: `鲸鲸出错了：${error.message}`, error: true };
      }
      return { text: `不认识定期操作：${args.action}`, error: true };
    },
  },
];
