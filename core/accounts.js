// 账户（钱放在哪）：树形，余额正数算资产、负数算欠款。

import { randomUUID } from 'node:crypto';
import { parseSignedAmountToCents } from './money.js';

// 这些是“说话当时的指代”，不是账户的永久别名。
const CONTEXTUAL_ALIAS =
  /另一张|第二张|第一张|这张|那张|刚才|上一张|前一张|别的卡|其他卡|^(我|我的|你|你的|他|他的|她|她的|咱们|我们的|我家|俺|本人)/;

export function sanitizeAliases(aliases = []) {
  return [
    ...new Set(
      aliases
        .map((alias) => String(alias).trim())
        .filter((alias) => alias && !CONTEXTUAL_ALIAS.test(alias)),
    ),
  ];
}

/** 只返回“当前唯一有效”的别名；两个账户共用的通用别名不生效。 */
export function effectiveAliases(accounts, account) {
  return [...new Set(account.aliases || [])].filter((alias) => {
    if (!alias || alias === account.name) return false;
    const matches = accounts.filter(
      (candidate) => candidate.name === alias || (candidate.aliases || []).includes(alias),
    );
    return matches.length === 1 && matches[0].id === account.id;
  });
}

export function resolveAccount(accounts, key) {
  if (key === null || key === undefined || key === '') return null;

  const byId = accounts.find((account) => account.id === key);
  if (byId) return byId;

  const matches = accounts.filter(
    (account) => account.name === key || effectiveAliases(accounts, account).includes(key),
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`账户「${key}」有好几个（${matches.map((a) => a.name).join('、')}），是哪一张？`);
  }
  return null;
}

/** 给提问用的结构化付款账户选项：名称、类型、余额、有效别名。 */
export function accountOptionRows(store) {
  const balances = balancesByAccount(store.accounts, store.vouchers());
  return store.accounts
    .filter((account) => isPaymentAccount(store.accounts, account))
    .map((account) => {
      const tags = account.tags || [];
      return {
        id: account.id,
        name: account.name,
        type: tags.includes('credit_card')
          ? 'credit_card'
          : tags.includes('investment')
            ? 'investment'
            : 'account',
        balanceCents: balances.get(account.id) || 0,
        aliases: effectiveAliases(store.accounts, account),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

export function isGroupAccount(accounts, account) {
  return accounts.some((candidate) => candidate.parentId === account.id);
}

const NON_PAYMENT_GROUPS = new Set(['待摊费用', '库存商品', '红包券', '往来', '应付款', '债权', '债务']);
const NON_PAYMENT_NAMES = new Set(['库存商品', '红包券']);

/** 能不能作为「从哪个账户付款」的候选：排除组、待摊/库存/红包券/往来/投资等。 */
const ASSET_CLASS_LABELS = {
  cash: '现金',
  bank: '银行',
  ewallet: '电子钱包',
  investment: '投资',
  deposit: '定期/存款',
  property: '房产',
  inventory: '库存',
  prepaid: '待摊',
  receivable: '应收',
  payable: '应付',
  credit: '信用卡',
  other: '其他',
};

export function assetClassLabel(value) {
  return ASSET_CLASS_LABELS[value] || ASSET_CLASS_LABELS.other;
}

export function inferAssetClass(accounts, account) {
  if (account.assetClass) return account.assetClass;
  const tags = account.tags || [];
  const name = account.name || '';
  if (tags.includes('credit_card')) return 'credit';
  if (tags.includes('investment')) return 'investment';
  if (/定期|存款/.test(name)) return 'deposit';
  if (/现金/.test(name)) return 'cash';
  if (/支付宝|微信|余额宝|零钱/.test(name)) return 'ewallet';
  if (/待摊/.test(name)) return 'prepaid';
  if (/房|地产/.test(name)) return 'property';
  if (/库存/.test(name)) return 'inventory';
  if (/银行|卡/.test(name)) return 'bank';
  return 'other';
}

/** 设置账户资产分类；只影响报表归类，不动余额。 */
export function setAssetClass(store, account, value) {
  if (!value || typeof value !== 'string') throw new Error('资产分类要是字符串');
  account.assetClass = value;
  store.saveAccounts();
  store.audit({ action: 'set-asset-class', accountId: account.id, assetClass: value, at: new Date().toISOString() });
  return account;
}

/** 能不能作为「从哪个账户付款」的候选：排除组、待摊/库存/红包券/往来/投资等。 */
export function isPaymentAccount(accounts, account) {
  if (account.archived || isGroupAccount(accounts, account)) return false;
  if (account.paymentEligible === false) return false;
  if ((account.tags || []).includes('investment')) return false;
  if (NON_PAYMENT_NAMES.has(account.name) || /^待摊-/.test(account.name)) return false;
  const parent = account.parentId ? accounts.find((candidate) => candidate.id === account.parentId) : null;
  if (parent && NON_PAYMENT_GROUPS.has(parent.name)) return false;
  return true;
}

/** 借记卡 ↔ 信用卡：只改类型标签和信用卡资料，不动余额和历史。 */
export function changeAccountType(store, account, options = {}) {
  if (typeof options.credit !== 'boolean') throw new Error('要说明是信用卡还是借记卡');
  const tags = new Set(account.tags || []);
  if (options.credit) {
    tags.add('credit_card');
  } else {
    tags.delete('credit_card');
    if (account.meta && account.meta.credit_card) {
      const meta = { ...account.meta };
      delete meta.credit_card;
      account.meta = meta;
    }
  }
  account.tags = [...tags];
  store.saveAccounts();
  store.audit({
    action: 'change-account-type',
    accountId: account.id,
    credit: options.credit,
    at: new Date().toISOString(),
  });
  return account;
}

export function accountFlowsCents(accountId, vouchers) {
  let total = 0;
  for (const voucher of vouchers) {
    for (const entry of voucher.entries || []) {
      if (entry.target !== 'account' || entry.id !== accountId) continue;
      total += entry.side === 'debit' ? entry.amountCents : -entry.amountCents;
    }
  }
  return total;
}

export function accountBalanceCents(account, vouchers) {
  const value = investmentValueCents(account);
  if (value !== null) return value;
  return (account.initialBalanceCents || 0) + accountFlowsCents(account.id, vouchers);
}

/**
 * 把用户说的「现在余额」解释成带符号的目标余额。
 * 信用卡：正数默认按欠款（负数）理解；owed=false 可强制当资产。
 */
export function balanceTargetCents(account, rawAmount, options = {}) {
  const cents = parseSignedAmountToCents(rawAmount);
  const isCreditCard = (account.tags || []).includes('credit_card');
  if (options.owed === true && cents > 0) return -cents;
  if (options.owed === false) return cents;
  if (isCreditCard && cents > 0) return -cents;
  return cents;
}

/** 按「现在余额」倒推期初，并写审计记录；CLI 和插件共用。 */
export function setInitialBalanceTo(store, account, targetCents) {
  const flowsCents = accountFlowsCents(account.id, store.vouchers());
  const initialCents = targetCents - flowsCents;
  account.initialBalanceCents = initialCents;
  account.initialKnown = true;
  store.saveAccounts();
  store.audit({
    action: 'init-balance',
    accountId: account.id,
    targetCents,
    flowsCents,
    initialCents,
    at: new Date().toISOString(),
  });
  return { targetCents, flowsCents, initialCents };
}

/**
 * 投资账户：余额 = 份额 × 净值。
 * 份额和净值都按 1/10000 存成整数，市值算到分。
 */
export function investmentValueCents(account) {
  const investment = account.meta && account.meta.investment;
  if (!investment) return null;
  if (Number.isSafeInteger(investment.valueCents)) return investment.valueCents;
  const { sharesScaled, navScaled } = investment;
  if (!Number.isSafeInteger(sharesScaled) || !Number.isSafeInteger(navScaled)) return null;
  const product = sharesScaled * navScaled;
  if (!Number.isSafeInteger(product)) throw new Error('份额×净值太大，鲸鲸算不了');
  return Math.round(product / 1_000_000);
}

/** 账户组按任意一层汇总：叶子取自己的余额，组取子树合计。 */
export function subtreeBalanceCents(accounts, balances, accountId) {
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) return 0;
  const children = accounts.filter((candidate) => candidate.parentId === accountId);
  if (!children.length) return balances.get(accountId) || 0;
  return children.reduce((total, child) => total + subtreeBalanceCents(accounts, balances, child.id), 0);
}

export function balancesByAccount(accounts, vouchers) {
  const result = new Map();
  for (const account of accounts) result.set(account.id, accountBalanceCents(account, vouchers));
  return result;
}

export function createAccount(accounts, options = {}) {
  const {
    name,
    parentId = null,
    aliases = [],
    tags = [],
    meta = null,
    initialBalanceCents = 0,
    initialKnown = false,
    excludeFromAssets = false,
    assetClass = null,
  } = options;

  if (!name) throw new Error('账户要有名字');
  if (accounts.some((account) => account.name === name)) throw new Error(`账户「${name}」已经存在`);
  if (parentId && !accounts.some((account) => account.id === parentId)) {
    throw new Error('上级账户不存在');
  }
  if (!Number.isSafeInteger(initialBalanceCents)) throw new Error('期初余额要是整数分');

  const account = {
    id: `a_${randomUUID().slice(0, 8)}`,
    name,
    parentId,
    aliases: sanitizeAliases(aliases),
    tags: [...new Set(tags)],
    meta,
    initialBalanceCents,
    initialKnown,
    excludeFromAssets,
    assetClass,
    archived: false,
    createdAt: new Date().toISOString(),
  };
  accounts.push(account);
  return account;
}

/** 账户改名/加别名；旧名字默认留作别名，方便旧说法还能对上。 */
export function renameAccount(store, account, options = {}) {
  const newName = options.newName;
  if (!newName) throw new Error('新名字是空的');
  const conflict = store.accounts.find(
    (candidate) => candidate.id !== account.id && candidate.name === newName,
  );
  if (conflict) throw new Error(`已经有账户叫「${newName}」了`);

  const oldName = account.name;
  const aliases = sanitizeAliases([
    ...(account.aliases || []),
    ...(options.aliases || []),
    ...(options.keepOldName !== false ? [oldName] : []),
  ]);

  account.name = newName;
  account.aliases = aliases;
  store.saveAccounts();
  store.audit({
    action: 'rename-account',
    accountId: account.id,
    oldName,
    newName,
    at: new Date().toISOString(),
  });
  return { account, oldName };
}

/** 更新/清理别名：默认在现有别名上追加；replace 时整体替换。 */
export function setAccountAliases(store, account, aliases = [], options = {}) {
  const base = options.replace ? [] : account.aliases || [];
  account.aliases = sanitizeAliases([...base, ...aliases]);
  store.saveAccounts();
  store.audit({
    action: 'aliases-account',
    accountId: account.id,
    aliases: account.aliases,
    at: new Date().toISOString(),
  });
  return account;
}

export function ensureDefaultAccount(store) {
  let account = store.accounts.find((candidate) => candidate.name === '默认账户1');
  if (!account) {
    account = createAccount(store.accounts, { name: '默认账户1' });
    store.saveAccounts();
  }
  return account;
}

/** 确保有一个账户组（比如“往来”“应付款”“待摊费用”）。 */
export function ensureAccountGroup(store, name) {
  const existing = store.accounts.find((candidate) => candidate.name === name);
  if (existing) return existing;
  const created = createAccount(store.accounts, { name });
  store.saveAccounts();
  return created;
}

/** 确保组下面有一个具体账户（比如“往来/小王”“应付款-手机”）。 */
export function ensureChildAccount(store, groupName, childName, options = {}) {
  const group = ensureAccountGroup(store, groupName);
  const existing = store.accounts.find(
    (candidate) => candidate.parentId === group.id && candidate.name === childName,
  );
  if (existing) return existing;
  const created = createAccount(store.accounts, {
    initialKnown: true,
    ...options,
    name: childName,
    parentId: group.id,
  });
  store.saveAccounts();
  return created;
}

export function accountReferences(store, account) {
  const reasons = [];
  if (store.accounts.some((candidate) => candidate.parentId === account.id)) reasons.push('还有子账户');
  if (store.vouchers().some((voucher) => (voucher.entries || []).some((entry) => entry.target === 'account' && entry.id === account.id))) {
    reasons.push('还有历史单据');
  }
  if ((store.loans || []).some((loan) => loan.debtorAccountId === account.id)) reasons.push('还有债权');
  if ((store.debts || []).some((debt) => debt.creditorAccountId === account.id)) reasons.push('还有债务');
  if ((store.plans || []).some((plan) => plan.assetAccountId === account.id || plan.payableAccountId === account.id)) {
    reasons.push('还有分期/待摊计划');
  }
  if (store.meta && store.meta.config && store.meta.config.defaultAccountId === account.id) reasons.push('是默认账户');
  return reasons;
}

export function deleteAccount(store, account) {
  const reasons = accountReferences(store, account);
  if (reasons.length) {
    return { ok: false, errors: [{ code: 'REFERENCED', message: `不能删：${reasons.join('、')}。可以改成归档，保留历史。` }] };
  }
  store.accounts = store.accounts.filter((candidate) => candidate.id !== account.id);
  store.saveAccounts();
  store.audit({ action: 'delete-account', accountId: account.id, name: account.name, at: new Date().toISOString() });
  return { ok: true, account };
}

export function archiveAccount(store, account) {
  account.archived = true;
  account.excludeFromAssets = true;
  store.saveAccounts();
  store.audit({ action: 'archive-account', accountId: account.id, name: account.name, at: new Date().toISOString() });
  return { ok: true, account };
}

export function unarchiveAccount(store, account) {
  account.archived = false;
  account.excludeFromAssets = false;
  store.saveAccounts();
  store.audit({ action: 'unarchive-account', accountId: account.id, name: account.name, at: new Date().toISOString() });
  return { ok: true, account };
}

/** 老数据清理：别名/标签去重，保证数组类型。 */
export function normalizeAccounts(accounts) {  let changed = false;
  for (const account of accounts) {
    if (!Array.isArray(account.aliases)) {
      account.aliases = [];
      changed = true;
    }
    if (Array.isArray(account.tags)) {
      const deduped = [...new Set(account.tags)];
      if (deduped.length !== account.tags.length) {
        account.tags = deduped;
        changed = true;
      }
    } else {
      account.tags = [];
      changed = true;
    }
  }
  return changed;
}

function longestCommonSubstringLength(a, b) {
  const left = [...String(a)];
  const right = [...String(b)];
  let best = 0;
  let previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

/** 找不到精确账户时，按名字/别名的公共片段给候选，避免模型瞎猜。 */
export function suggestAccounts(accounts, query, limit = 4) {
  const text = String(query || '').trim();
  if (!text) return [];
  return accounts
    .filter((account) => !account.archived)
    .map((account) => {
      const score = Math.max(
        ...[account.name, ...(account.aliases || [])].map((name) => longestCommonSubstringLength(text, name)),
      );
      return { account, score };
    })
    .filter((entry) => entry.score >= 2)
    .sort((a, b) => b.score - a.score || a.account.name.localeCompare(b.account.name, 'zh'))
    .slice(0, limit)
    .map((entry) => entry.account);
}
