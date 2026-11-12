// 鲸娘管家 DSH 插件入口：聚合各领域工具并注册。

import { setWorkingDirectory } from './tools/shared.js';
import { accountingTools } from './tools/accounting.js';
import { queryTools } from './tools/query.js';
import { accountTools } from './tools/account.js';
import { cardTools } from './tools/card.js';
import { inventoryTools } from './tools/inventory.js';
import { depositTools } from './tools/deposit.js';
import { receivableTools } from './tools/receivable.js';
import { debtTools } from './tools/debt.js';
import { prepaidTools } from './tools/prepaid.js';

export const inject = ['tools', 'workingDirectory', 'systemPrompt'];

export const tools = [
  ...accountingTools,
  ...queryTools,
  ...accountTools,
  ...cardTools,
  ...inventoryTools,
  ...depositTools,
  ...receivableTools,
  ...debtTools,
  ...prepaidTools,
];

// 金额书写规则：模型自己写出来的文字（提问选项、回复）也照这个来。
const MONEY_FORMAT_TEXT = [
  '鲸娘管家：凡是出现本账本的金额，只写金额本身，带货币符号和千分位，例如 ¥16,003.00、-¥6,318.52。',
  '正数表示余额，负数表示欠款，靠正负号区分就够了。',
  '问用户从哪张卡付时：选项标题只写账户名，例如「建行信用卡1234」；选项下面的补充说明只写金额，例如「-¥1,000.00」。',
  '账本文件只能通过 whale_* 工具修改；不要用 write/edit 直接改账本 JSON。',
].join('\n');

function argumentPath(value) {
  if (!value || typeof value !== 'object') return '';
  return String(value.file_path || value.path || value.filename || '');
}

export function ledgerWriteGuard(execution) {
  if (!execution || !['write', 'edit'].includes(execution.name)) return undefined;
  const target = argumentPath(execution.arguments).replaceAll('\\', '/');
  if (!/(^|\/)whale-butler(\/|$)/i.test(target)) return undefined;
  return '账本文件只能通过 whale_* 工具改；不要用 write/edit 直接改 JSON。';
}

export function apply(ctx) {
  setWorkingDirectory(ctx.workingDirectory);
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool));
  }
  if (ctx.tools && typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard(ledgerWriteGuard));
  }
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: 'whale-butler-money-format',
        order: 900,
        text: MONEY_FORMAT_TEXT,
      }),
    );
  }
}
