// account 领域工具。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Store } from '../core/store.js';
import { fixVoucher, buildRefundVoucher, buildVoucher, todayInShanghai } from '../core/ledger.js';
import { buildCartVoucher } from '../core/cart.js';
import { postParsedVoucher } from '../core/snap.js';
import {
  accountReferences,
  archiveAccount,
  balanceTargetCents,
  balancesByAccount,
  createAccount,
  deleteAccount,
  renameAccount,
  resolveAccount,
  setAccountAliases,
  setInitialBalanceTo,
  suggestAccounts,
  unarchiveAccount,
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
import { categoryPath, findCategory, migrateCategoryTaxonomy } from '../core/categories.js';
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

export const accountTools = [
  {
    name: 'whale_account',
    description:
      '鲸娘管家账户操作：加账户、改名/加别名、看账户、按别名找账户、设投资账户、补期初、设默认账户。用户说「建个工行卡」「1234 是哪张」「把建行信用卡2 改名成 1234」时用。改名用 rename，不要手改 accounts.json。补余额时：借记卡问「这笔之后卡里还有多少钱」，信用卡问「这笔之后还欠多少」；信用卡正数会按欠款记成负数。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'add',
            'list',
            'find',
            'rename',
            'aliases',
            'invest',
            'initial-balance',
            'default-account',
            'delete',
            'archive',
            'unarchive',
          ],
        },
        name: { type: 'string' },
        newName: { type: 'string', description: 'rename 时的新名字' },
        keepOldName: { type: 'boolean', description: 'rename 时是否把旧名字留作别名，默认 true' },
        replace: { type: 'boolean', description: 'aliases 时是否整体替换现有别名' },
        parent: { type: 'string' },
        aliases: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        credit: { type: 'boolean' },
        excludeAssets: { type: 'boolean' },
        initial: { type: 'string', description: '期初余额' },
        shares: { type: 'string', description: '份额' },
        nav: { type: 'string', description: '净值' },
        cost: { type: 'string', description: '成本' },
        amount: {
          type: 'string',
          description: '补期初时的「这笔之后」余额；信用卡欠款用负数，如 -1500.2；正数也会按欠款处理',
        },
        owed: { type: 'boolean', description: 'true 表示这是欠款（会记成负数）；信用卡默认按欠款理解' },
        confirm: { type: 'boolean', description: '删除账户时确认：true 才会真删' },
        query: { type: 'string', description: 'find 时找的词，如 1234' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      const action = args && args.action;
      try {
        if (action === 'add') {
          if (!args.name) return { text: '账户要有个名字', error: true };
          const existing = resolveAccount(store.accounts, args.name);
          if (existing) return { text: `账户「${existing.name}」已经在了，直接用～` };
          const tags = [...(args.tags || [])];
          if (args.credit) tags.push('credit_card');
          const options = {
            name: args.name,
            aliases: args.aliases || [],
            tags,
            excludeFromAssets: Boolean(args.excludeAssets),
            initialKnown: false,
            initialBalanceCents: 0,
          };
          if (args.parent) {
            const parent = resolveAccount(store.accounts, args.parent);
            if (!parent) return { text: `没找到上级账户「${args.parent}」`, error: true };
            options.parentId = parent.id;
          }
          const account = createAccount(store.accounts, options);
          let initialNote = '';
          if (args.initial !== undefined) {
            const targetCents = balanceTargetCents(account, args.initial);
            const result = setInitialBalanceTo(store, account, targetCents);
            initialNote = ` 期初 ${formatYuan(result.initialCents)} 元`;
            if ((account.tags || []).includes('credit_card') && targetCents < 0) {
              initialNote += `（按欠款 ${formatYuan(targetCents)} 记）`;
            }
          }
          store.saveAccounts();
          store.audit({
            action: 'create-account',
            accountId: account.id,
            name: account.name,
            at: new Date().toISOString(),
          });
          return { text: `建好账户「${account.name}」啦～${initialNote}` };
        }
        if (action === 'delete') {
          const account = resolveAccount(store.accounts, args.name);
          if (!account) return { text: `没找到账户「${args.name}」`, error: true };
          const reasons = accountReferences(store, account);
          if (reasons.length) {
            return {
              text: `「${account.name}」不能硬删：${reasons.join('、')}。可以归档（保留历史、不计资产）。`,
              error: true,
            };
          }
          if (!args.confirm) {
            return {
              text: `要删「${account.name}」的话，确认一下：删掉后它不再计入资产/负债，历史不会保留。确认请带 confirm=true。`,
              needsQuestion: true,
            };
          }
          const result = deleteAccount(store, account);
          if (!result.ok) return { text: errorsMessage(result.errors), error: true };
          return { text: `账户「${result.account.name}」删掉了；它不再计入净资产，没有生成收支分录。` };
        }
        if (action === 'archive') {
          const account = resolveAccount(store.accounts, args.name);
          if (!account) return { text: `没找到账户「${args.name}」`, error: true };
          archiveAccount(store, account);
          return { text: `账户「${account.name}」已归档：历史保留，但不再计入资产。` };
        }
        if (action === 'unarchive') {
          const account = resolveAccount(store.accounts, args.name);
          if (!account) return { text: `没找到账户「${args.name}」`, error: true };
          unarchiveAccount(store, account);
          return { text: `账户「${account.name}」已恢复，重新计入资产。` };
        }
        if (action === 'list') return { text: accountListText(store) };
        if (action === 'find') {
          const result = resolveAccountReference(store.accounts, args.query, {
            defaultAccountId: store.meta.config.defaultAccountId,
          });
          if (result.ok) return { text: `找到「${result.account.name}」啦～` };
          if (result.reason === 'multiple') {
            return {
              text: `「${args.query}」对上了 ${result.candidates.length} 张：${result.candidates
                .map((account) => account.name)
                .join('、')}。是哪一张？`,
            };
          }
          const candidates = suggestAccounts(store.accounts, args.query);
          const hint = candidates.length
            ? `你是不是指：${candidates.map((account) => account.name).join('、')}？`
            : '如果是另一张卡，告诉我卡名或尾号（比如 建行6688），我先建账户再记；不要先记到别的卡上。';
          return { text: `没找到「${args.query}」～ ${hint}` };
        }
        if (action === 'rename') {
          const account = resolveAccount(store.accounts, args.name);
          if (!account) return { text: `没找到账户「${args.name}」`, error: true };
          if (!args.newName) return { text: '新名字是什么？', error: true };
          const result = renameAccount(store, account, {
            newName: args.newName,
            aliases: args.aliases,
            keepOldName: args.keepOldName !== false,
          });
          return {
            text: `改好啦～「${result.oldName}」现在叫「${account.name}」。别名：${account.aliases.join('、') || '（没有）'}`,
          };
        }
        if (action === 'aliases') {
          const account = resolveAccount(store.accounts, args.name);
          if (!account) return { text: `没找到账户「${args.name}」`, error: true };
          setAccountAliases(store, account, args.aliases || [], { replace: args.replace === true });
          return {
            text: `别名更新好啦～${account.name}：${account.aliases.join('、') || '（没有别名）'}`,
          };
        }
        if (action === 'invest') {
          const account = resolveAccount(store.accounts, args.name);
          if (!account) return { text: `没找到账户「${args.name}」`, error: true };
          const sharesScaled = parseScaledInteger(args.shares ?? '0', 4);
          const navScaled = parseScaledInteger(args.nav ?? '0', 4);
          const costCents = args.cost !== undefined ? parseAmountToCents(args.cost) : 0;
          if (!(account.tags || []).includes('investment')) account.tags.push('investment');
          account.meta = { ...(account.meta || {}), investment: { sharesScaled, navScaled, costCents } };
          store.saveAccounts();
          return {
            text: `投资账户「${account.name}」更新好啦～份额 ${formatScaledInteger(
              sharesScaled,
            )} ｜ 净值 ${formatScaledInteger(navScaled)} ｜ 成本 ${formatYuan(costCents)}`,
          };
        }
        if (action === 'initial-balance') {
          const account = resolveAccount(store.accounts, args.name);
          if (!account) return { text: `没找到账户「${args.name}」`, error: true };
          if (args.amount === undefined) return { text: '要告诉我现在余额多少', error: true };
          const targetCents = balanceTargetCents(account, args.amount, { owed: args.owed });
          const result = setInitialBalanceTo(store, account, targetCents);
          let text = `收到～${account.name} 现在 ${formatYuan(result.targetCents)}。往前一算：之前流水 ${formatYuan(
            result.flowsCents,
          )}，所以期初应该是 ${formatYuan(result.initialCents)}。已经记好啦。`;
          if ((account.tags || []).includes('credit_card') && result.targetCents < 0) {
            text += '\n  这张是信用卡，按欠款记成负数啦。';
          }
          const recent = accountTransactions(store, account, 2);
          if (recent.length) {
            text += `\n  最近流水：${recent
              .map(
                (row) =>
                  `${row.date} ${row.memo || row.type} ${row.side === 'debit' ? '+' : '-'}${formatYuan(
                    row.amountCents,
                  )}`,
              )
              .join('；')}`;
          }
          return { text };
        }
        if (action === 'default-account') {
          const account = resolveAccount(store.accounts, args.name);
          if (!account) return { text: `没找到账户「${args.name}」`, error: true };
          store.meta.config.defaultAccountId = account.id;
          store.saveMeta();
          return { text: `默认账户改成「${account.name}」啦～` };
        }
        return { text: `不认识的账户操作：${action}`, error: true };
      } catch (error) {
        return { text: `鲸鲸出错了：${error.message}`, error: true };
      }
    },
  },
  {
    name: 'whale_category',
    description:
      '类别管理：查看支出/收入类别；新增、改名、移动、删除、迁移。记账时不确定记哪个类别，先查一下。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'rename', 'move', 'delete', 'migrate'] },
        name: { type: 'string', description: '类别名/id' },
        newName: { type: 'string', description: 'rename 时的新名字' },
        kind: { type: 'string', enum: ['expense', 'income'], description: '支出类别还是收入类别' },
        parent: { type: 'string', description: '上级类别（add/move 时用）' },
        confirm: { type: 'boolean', description: '删除类别时确认：true 才会真删' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await openStore(exec);
      if (args.action === 'list') return { text: categoryListText(store) };
      if (args.action === 'migrate') {
        const changed = migrateCategoryTaxonomy(store.categories);
        store.meta.config.categorySchemaVersion = 2;
        if (changed) store.saveCategories();
        store.saveMeta();
        store.audit({ action: 'category-migrate', at: new Date().toISOString() });
        return { text: changed ? '类目已迁移到新体系；旧单据按 id 自动跟随。' : '类目已经是新体系，不用再迁。' };
      }
      if (args.action === 'rename') {
        const category = findCategory(store.categories, args.name);
        if (!category) return { text: `没找到类别「${args.name}」`, error: true };
        if (!args.newName) return { text: '要告诉我新名字', error: true };
        if (
          store.categories.some(
            (candidate) => candidate.id !== category.id && candidate.name === args.newName && candidate.kind === category.kind,
          )
        ) {
          return { text: `「${args.newName}」这个类别已经有了`, error: true };
        }
        const oldName = category.name;
        category.name = args.newName;
        category.aliases = [...new Set([...(category.aliases || []), oldName])];
        store.saveCategories();
        store.audit({ action: 'category-rename', categoryId: category.id, from: oldName, to: category.name, at: new Date().toISOString() });
        return { text: `类别「${oldName}」改名为「${category.name}」啦～` };
      }
      if (args.action === 'move') {
        const category = findCategory(store.categories, args.name);
        if (!category) return { text: `没找到类别「${args.name}」`, error: true };
        const parent = args.parent ? findCategory(store.categories, args.parent) : null;
        if (args.parent && !parent) return { text: `没找到上级类别「${args.parent}」`, error: true };
        if (parent && parent.kind !== category.kind) return { text: '上级类别的收支类型要一样', error: true };
        let cursor = parent;
        while (cursor) {
          if (cursor.id === category.id) return { text: '不能把类别移到自己的下级去', error: true };
          cursor = cursor.parentId ? store.categories.find((item) => item.id === cursor.parentId) : null;
        }
        category.parentId = parent ? parent.id : null;
        store.saveCategories();
        store.audit({ action: 'category-move', categoryId: category.id, parentId: category.parentId, at: new Date().toISOString() });
        return { text: `类别「${category.name}」移到「${parent ? parent.name : '一级'}」啦～` };
      }
      if (args.action === 'delete') {
        const category = findCategory(store.categories, args.name);
        if (!category) return { text: `没找到类别「${args.name}」`, error: true };
        const reasons = [];
        if (store.categories.some((item) => item.parentId === category.id)) reasons.push('还有子类');
        if ((store.plans || []).some((plan) => plan.categoryId === category.id)) reasons.push('还有待摊计划');
        if (
          store.vouchers().some((voucher) =>
            (voucher.entries || []).some((entry) => entry.target === 'category' && entry.id === category.id),
          )
        ) {
          reasons.push('还有历史单据');
        }
        if (reasons.length) {
          return { text: `「${category.name}」不能删：${reasons.join('、')}。可以改名/移动，或把单据改到别的类别。`, error: true };
        }
        if (!args.confirm) {
          return { text: `要删类别「${category.name}」的话，确认一下：历史里没有引用才会删。确认请带 confirm=true。`, needsQuestion: true };
        }
        store.categories = store.categories.filter((item) => item.id !== category.id);
        store.saveCategories();
        store.audit({ action: 'category-delete', categoryId: category.id, name: category.name, at: new Date().toISOString() });
        return { text: `类别「${category.name}」删掉了。` };
      }
      if (args.action === 'add') {
        if (!args.name) return { text: '类别要有个名字', error: true };
        const kind = args.kind === 'income' ? 'income' : 'expense';
        if (store.categories.some((category) => category.name === args.name && category.kind === kind)) {
          return { text: `「${args.name}」这个类别已经有了`, error: true };
        }
        let parentId = null;
        if (args.parent) {
          const parent = findCategory(store.categories, args.parent);
          if (!parent) return { text: `没找到上级类别「${args.parent}」`, error: true };
          if (parent.kind !== kind) return { text: '上级类别的收支类型要一样', error: true };
          parentId = parent.id;
        }
        const id = `${kind === 'expense' ? 'exp_custom' : 'inc_custom'}_${randomUUID().slice(0, 8)}`;
        store.categories.push({ id, name: args.name, kind, parentId, system: false });
        store.saveCategories();
        return { text: `加好类别「${args.name}」啦～` };
      }
      return { text: `不认识的类别操作：${args.action}`, error: true };
    },
  },
];
