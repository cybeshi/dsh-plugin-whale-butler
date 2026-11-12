// inventory 领域工具。

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
import { createDaigou, listDaigous } from '../core/daigou.js';
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

export const inventoryTools = [
  {
    name: 'whale_product',
    description: '商品管理：新增、列出、查找商品。商品名、品牌、规格、单位会用于库存和进价历史。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'find'] },
        name: { type: 'string', description: '商品名' },
        brand: { type: 'string', description: '品牌，如 洁婷' },
        spec: { type: 'string', description: '规格，如 30片' },
        unit: { type: 'string', description: '单位，如 包、瓶、件' },
        aliases: { type: 'array', items: { type: 'string' } },
        query: { type: 'string', description: 'find 时找的商品名/别名' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      if (args.action === 'add') {
        if (!args.name) return { text: '商品要有个名字', error: true };
        try {
          const product = createProduct(store, args);
          return {
            text: `商品「${product.name}」记好啦～${product.spec ? ` 规格 ${product.spec}` : ''}${
              product.unit ? ` ｜ 单位 ${product.unit}` : ''
            }`,
          };
        } catch (error) {
          return { text: `鲸鲸出错了：${error.message}`, error: true };
        }
      }
      if (args.action === 'list') {
        if (!store.products.length) return { text: '还没有商品～先用 whale_product add 建一个。' };
        return {
          text: store.products
            .map(
              (product) =>
                `${product.name}${product.spec ? `（${product.spec}）` : ''}${
                  product.unit ? ` · ${product.unit}` : ''
                } · ${product.id}`,
            )
            .join('\n'),
        };
      }
      if (args.action === 'find') {
        const product = findProduct(store, args.query || args.name);
        return { text: product ? `找到「${product.name}」啦～（${product.id}）` : '没找到这个商品～' };
      }
      return { text: `不认识商品操作：${args.action}`, error: true };
    },
  },
  {
    name: 'whale_inventory',
    description:
      '进销存：进货、销售、客户退货、供应商退货、期初库存。成本用移动加权平均；库存商品记成资产，销售收入/销售成本记经营。退货挂原单。先分清用途：自家用记普通支出；替特定买家代购用 daigou；先备货再卖用 purchase/sale。用户没提买家、没提转售时，不要自动建库存，按最简单的普通支出/代购假设记并说明。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['purchase', 'sale', 'daigou', 'return_sale', 'return_purchase', 'stock_init'],
        },
        product: { type: 'string', description: '商品名或 id；进货时可自动建商品' },
        qty: { type: 'string', description: '数量，如 8 或 1.5' },
        unitPrice: { type: 'string', description: '单价' },
        total: { type: 'string', description: '总价/总成本' },
        cost: { type: 'string', description: '代购成本（帮别人买的实际花费）' },
        customer: { type: 'string', description: '客户名；不填 account 时挂应收' },
        payAccount: { type: 'string', description: '代购垫付的付款账户' },
        collectAccount: { type: 'string', description: '代购收款的账户' },
        costPaid: { type: 'boolean', description: '代购成本是否已经付过/记过；true 时只记收款' },
        freight: { type: 'string', description: '进货运费，计入成本' },
        account: { type: 'string', description: '付款/收款账户；销售时可省略，改挂客户应收' },
        supplier: { type: 'string', description: '供应商，可选' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        saleId: { type: 'string', description: '客户退货时挂原销售单' },
        purchaseId: { type: 'string', description: '供应商退货时挂原进货单' },
        refund: { type: 'string', description: 'actual 退款金额' },
        restock: { type: 'boolean', description: '客户退货是否回库，默认 true' },
        memo: { type: 'string' },
        sourceText: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const before = balancesByAccount(store.accounts, store.vouchers());
      try {
        if (args.action === 'purchase') {
          return inventoryResultText(store, purchaseStock(store, args), 'purchase', before);
        }
        if (args.action === 'sale') {
          return inventoryResultText(store, sellStock(store, args), 'sale', before);
        }
        if (args.action === 'return_sale') {
          return inventoryResultText(
            store,
            returnSale(store, { ...args, restock: args.restock !== false }),
            'return_sale',
            before,
          );
        }
        if (args.action === 'return_purchase') {
          return inventoryResultText(store, returnPurchase(store, args), 'return_purchase', before);
        }
        if (args.action === 'daigou') {
          const result = createDaigou(store, args);
          if (result.needsQuestion) return { text: questionMessage(result), needsQuestion: true };
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return {
            text: [
              `代购记好啦～${result.record.customerName}`,
              `  成本 ${formatYuan(result.record.costCents)} ｜ 收款 ${formatYuan(
                result.record.amountCents,
              )} ｜ 代购收入 ${formatYuan(result.record.profitCents)}`,
              '  成本走往来，不建库存；报表只看净代购收入。',
            ].join('\n'),
            daigouId: result.record.id,
          };
        }
        if (args.action === 'stock_init') {
          return inventoryResultText(store, addInitialStock(store, args), 'stock_init', before);
        }
      } catch (error) {
        return { text: `鲸鲸出错了：${error.message}`, error: true };
      }
      return { text: `不认识进销存操作：${args.action}`, error: true };
    },
  },
];
