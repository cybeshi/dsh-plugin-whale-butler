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

export const inject = ['tools', 'workingDirectory'];

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

export function apply(ctx) {
  setWorkingDirectory(ctx.workingDirectory);
  for (const tool of tools) {
    ctx.effect(() => ctx.tools.register(tool));
  }
}
