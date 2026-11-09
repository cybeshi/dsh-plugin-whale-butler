// 截图解析的入账管道：模型负责看图，这里负责把结果记进账本并留原文。

import fs from 'node:fs';
import path from 'node:path';
import { buildVoucher, postVoucher } from './ledger.js';
import { buildCartVoucher } from './cart.js';
import { ensureDir } from './store.js';

function storeAttachment(store, imagePath, voucherId) {
  const source = path.resolve(String(imagePath));
  if (!fs.existsSync(source)) return source;

  const dir = path.join(store.dataDir, 'attachments');
  ensureDir(dir);
  const extension = path.extname(source).toLowerCase() || '.png';
  const target = path.join(dir, `${voucherId}${extension}`);
  fs.copyFileSync(source, target);
  const relative = path.relative(store.dataDir, target);
  return relative.split(path.sep).join('/');
}

/**
 * @param {object} options
 * @param {object} options.spec 模型解析出来的单据/购物车内容
 * @param {string} [options.imagePath] 原始截图路径
 * @param {string} [options.parsedText] 识别出的原文
 */
export function postParsedVoucher(store, options = {}) {
  const spec = options.spec;
  if (!spec) return { ok: false, errors: [{ code: 'EMPTY', message: '没有解析结果' }] };

  const built = spec.lines ? buildCartVoucher(store, spec) : buildVoucher(store, spec);
  if (!built.ok || built.needsQuestion) return built;

  const voucher = built.voucher;
  voucher.parser = options.parser || 'model';
  voucher.parsedText = options.parsedText || '';
  if (options.imagePath) {
    voucher.sourceImage = storeAttachment(store, options.imagePath, voucher.id);
  }

  postVoucher(store, voucher);
  return { ok: true, voucher };
}
