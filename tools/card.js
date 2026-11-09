// card 领域工具。

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

export const cardTools = [
  {
    name: 'whale_card',
    description:
      '信用卡资料：设还款日、账单日、额度、年费政策，或共享余额的多张实体卡（如银联+Visa），或查看卡资料。只更新提供的字段，其他字段保留；年费进度只在设了年费金额 + 扣费日后可用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['set', 'status'] },
        account: { type: 'string', description: '信用卡账户名' },
        dueDay: { type: 'number', description: '每月还款日，1-31' },
        statementDay: { type: 'number', description: '每月账单日，1-31' },
        limit: { type: 'string', description: '额度，如 50000' },
        annualFee: { type: 'string', description: '年费金额，如 200' },
        feeDate: { type: 'string', description: '年费扣费日，月-日，如 05-01' },
        waiverCount: { type: 'number', description: '刷几笔免年费' },
        sharedCards: {
          type: 'array',
          description: '共享同一额度/欠款的多张实体卡，如银联 + Visa',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '卡片名，如 银联、Visa' },
              network: { type: 'string', description: '卡组织，如 UnionPay、Visa' },
              currency: { type: 'string', description: '常用币种，CNY/USD' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        asOf: { type: 'string', description: 'status 算到哪天，YYYY-MM-DD' },
      },
      required: ['action', 'account'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const account = resolveAccount(store.accounts, args.account);
      if (!account) return { text: `没找到账户「${args.account}」`, error: true };

      if (args.action === 'status') {
        let text = cardMetaText(account);
        const progress = cardProgress(store, account, args.asOf);
        text += '\n' + (progress ? cardProgressText(progress) : '（还没设年费政策，年费进度暂不可用）');
        return { text };
      }

      if (args.action === 'set') {
        let feeMonth;
        let feeDay;
        if (args.feeDate) {
          const [month, day] = String(args.feeDate).split('-').map(Number);
          feeMonth = month;
          feeDay = day;
          if (!feeMonth || !feeDay) return { text: '扣费日格式是 月-日，比如 05-01', error: true };
        }
        try {
          setCardPolicy(store, account, {
            dueDay: args.dueDay,
            statementDay: args.statementDay,
            limit: args.limit,
            fee: args.annualFee,
            feeMonth,
            feeDay,
            waiverCount: args.waiverCount,
            sharedCards: args.sharedCards,
          });
        } catch (error) {
          return { text: `鲸鲸出错了：${error.message}`, error: true };
        }
        let text = `卡资料更新好啦～\n${cardMetaText(account)}`;
        if (args.annualFee && !args.feeDate) {
          text += '\n（设了年费金额，但没给扣费日，年费进度暂不可用）';
        }
        return { text };
      }

      return { text: `不认识的卡操作：${args.action}`, error: true };
    },
  },
];
