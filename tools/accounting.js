// accounting 领域工具。

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

export const accountingTools = [
  {
    name: 'whale_expense',
    description:
      '记一笔日常支出（最常用）。只要金额、类别、付款账户，工具自己拼好借贷方向，不用模型写分录。多件商品、满减券、红包优惠请用 whale_cart。房租、取暖费、学费、住宿费、物业费、保险费、年付宽带这类覆盖一段时期的预付，改用 whale_prepaid，不要记成一次性支出。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，没说就今天' },
        amount: { type: 'string', description: '花了多少，如 11.5' },
        category: { type: 'string', description: '支出类别，如 食品' },
        account: { type: 'string', description: '付款账户，如 建行1234' },
        memo: { type: 'string' },
        sourceText: { type: 'string', description: '用户原话' },
        details: { type: 'array', items: detailSchema, description: '可选明细' },
        currency: { type: 'string', description: '外币币种，如 USD' },
        originalAmount: { type: 'string', description: '外币原金额' },
        exchangeRate: { type: 'string', description: '1 外币折人民币的汇率' },
      },
      required: ['amount', 'category', 'account'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      const built = buildVoucher(store, {
        date: args.date,
        type: 'expense',
        memo: args.memo || `${args.category}支出`,
        sourceText: args.sourceText,
        entries: [
          { target: 'category', category: args.category, side: 'debit', amount: args.amount },
          { target: 'account', account: args.account, side: 'credit', amount: args.amount },
        ],
        details: args.details,
      });
      if (built.needsQuestion) return { text: questionMessage(built), needsQuestion: true };
      if (!built.ok) return { text: errorsMessage(built.errors), error: true };
      attachForeignMeta(built.voucher, args);
      return postBuilt(store, built, before);
    },
  },
  {
    name: 'whale_income',
    description:
      '记一笔收入。只要金额、收入类别、到账账户，工具自己拼好借贷方向。工资、退款到账、利息都用它。红包/返现如果只是券、不进余额，传 coupon=true，会记到「红包券」（不计资产）；确实进了支付宝/银行卡余额才传 account。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，没说就今天' },
        amount: { type: 'string', description: '收到多少，如 8000' },
        category: { type: 'string', description: '收入类别，如 工资、红包' },
        account: { type: 'string', description: '到账账户，如 工行借记卡；coupon=true 时不用传' },
        coupon: { type: 'boolean', description: '红包/返现只是券、不进余额时传 true，记到红包券' },
        memo: { type: 'string' },
        sourceText: { type: 'string', description: '用户原话' },
      },
      required: ['amount', 'category'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      let entries;
      if (args.coupon) {
        const couponAccount = ensureCouponAccount(store);
        entries = [
          { target: 'account', id: couponAccount.id, side: 'debit', amount: args.amount },
          { target: 'category', category: args.category, side: 'credit', amount: args.amount },
        ];
      } else {
        if (!args.account) {
          return { text: '到账账户是哪个？如果只是红包券、不进余额，传 coupon=true。', error: true };
        }
        entries = [
          { target: 'account', account: args.account, side: 'debit', amount: args.amount },
          { target: 'category', category: args.category, side: 'credit', amount: args.amount },
        ];
      }
      const built = buildVoucher(store, {
        date: args.date,
        type: 'income',
        memo: args.memo || `${args.category}收入`,
        sourceText: args.sourceText,
        entries,
      });
      if (built.needsQuestion) return { text: questionMessage(built), needsQuestion: true };
      if (!built.ok) return { text: errorsMessage(built.errors), error: true };
      return postBuilt(store, built, before);
    },
  },
  {
    name: 'whale_record',
    description:
      '鲸娘管家记一笔账（通用版）。模型先把用户的话解析成单据再调用。方向别写反：支出类别在借（debit）、付款账户在贷（credit）；收入反过来（账户借、收入类别贷）。例：买菜 11.5，红包 5，卡 6.5 → 借 食品 11.5；贷 红包 5；贷 建行卡 6.5。日常简单支出/收入优先用 whale_expense、whale_income；覆盖一段时期的预付（房租/取暖/学费/保险等）用 whale_prepaid。',
    parameters: voucherSpecSchema,
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      const built = buildVoucher(store, args || {});
      if (built.needsQuestion) return { text: questionMessage(built), needsQuestion: true };
      if (!built.ok) return { text: errorsMessage(built.errors), error: true };
      attachForeignMeta(built.voucher, args);
      return postBuilt(store, built, before);
    },
  },
  {
    name: 'whale_cart',
    description:
      '鲸娘管家购物车记账：多件商品 + 满减/折扣摊销 + 红包收入 + 多个付款来源。摊减券只摊商品，不当收入；红包类优惠单独记收入。',
    parameters: cartSpecSchema,
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      const built = buildCartVoucher(store, args || {});
      if (built.needsQuestion) return { text: questionMessage(built), needsQuestion: true };
      if (!built.ok) return { text: errorsMessage(built.errors), error: true };
      return postBuilt(store, built, before);
    },
  },
  {
    name: 'whale_refund',
    description: '鲸娘管家退款：挂到原单上，原单不动；退款单独记「退款收入」，报表按毛额/净额看。',
    parameters: {
      type: 'object',
      properties: {
        originalId: { type: 'string', description: '原单号' },
        account: { type: 'string', description: '退到哪个账户' },
        amount: { type: 'string', description: '退款金额' },
        date: { type: 'string' },
        memo: { type: 'string' },
      },
      required: ['originalId', 'account', 'amount'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      const built = buildRefundVoucher(store, args || {});
      if (built.needsQuestion) return { text: questionMessage(built), needsQuestion: true };
      if (!built.ok) return { text: errorsMessage(built.errors), error: true };
      const result = postBuilt(store, built, before, [`  已挂到原单 ${args.originalId}，原单没动。`]);
      return result;
    },
  },
  {
    name: 'whale_snap',
    description:
      '鲸娘管家截图入账。模型先看截图、把识别结果整理成单据或购物车，再调用；会把图片原件（如果给了路径）和识别原文存进单据。',
    parameters: {
      type: 'object',
      properties: {
        imagePath: { type: 'string', description: '截图在本机的路径；没有就省略' },
        parsedText: { type: 'string', description: '从截图里识别出的原文' },
        spec: {
          type: 'object',
          description: '单据内容（entries）或购物车内容（lines）',
          additionalProperties: true,
        },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      const result = postParsedVoucher(store, {
        spec: args && args.spec,
        imagePath: args && args.imagePath,
        parsedText: (args && args.parsedText) || '',
      });
      if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
      if (!result.ok) return { text: errorsMessage(result.errors), error: true };
      return {
        text: describeVoucher(store, result.voucher, before, [
          `  截图 ${result.voucher.sourceImage || '（没有图片路径）'} 和识别原文都存进单据了。`,
        ]),
        voucherId: result.voucher.id,
      };
    },
  },
  {
    name: 'whale_fix',
    description:
      '修改/重分类已有单据：改类别、账户、金额、日期、摘要。保留修改历史（revision +1），不要手改 JSON，也不要用 CLI 绕过工具。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '单据号' },
        date: { type: 'string' },
        type: { type: 'string' },
        memo: { type: 'string' },
        entries: { type: 'array', items: entrySchema },
        details: { type: 'array', items: detailSchema },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const result = fixVoucher(store, args.id, {
        date: args.date,
        type: args.type,
        memo: args.memo,
        entries: args.entries,
        details: args.details,
      });
      if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
      if (!result.ok) return { text: errorsMessage(result.errors), error: true };
      return {
        text:
          fixMessage(result.voucher, result.before?.entries || []) +
          '\n  （revision +1，修改前的记录保留在历史里。）',
        voucherId: result.voucher.id,
      };
    },
  },
];
