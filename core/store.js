// 本地纯文件存储：meta.json / accounts.json / categories.json / vouchers/YYYY-MM.jsonl。
// 写入一律“临时文件 + 改名”，不让半截文件留在账本里。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureSeedCategories, seedCategories } from './categories.js';
import { normalizeAccounts } from './accounts.js';

const SCHEMA_VERSION = 1;

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.unlinkSync(file);
    } catch {
      // 文件本来就不在
    }
    fs.renameSync(tmp, file);
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function defaultMeta() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    config: {
      defaultAccountId: null,
      largeDiffThresholdCents: 5000,
      currency: 'CNY',
      categorySchemaVersion: 2,
    },
  };
}

export class Store {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    this.vouchersDir = path.join(this.dataDir, 'vouchers');
    this.metaFile = path.join(this.dataDir, 'meta.json');
    this.accountsFile = path.join(this.dataDir, 'accounts.json');
    this.categoriesFile = path.join(this.dataDir, 'categories.json');
    this.loansFile = path.join(this.dataDir, 'loans.json');
    this.plansFile = path.join(this.dataDir, 'plans.json');
    this.productsFile = path.join(this.dataDir, 'products.json');
    this.inventoryFile = path.join(this.dataDir, 'inventory.json');
    this.debtsFile = path.join(this.dataDir, 'debts.json');
    this.auditFile = path.join(this.dataDir, 'audit.jsonl');

    this.meta = defaultMeta();
    this.accounts = [];
    this.categories = [];
    this.loans = [];
    this.plans = [];
    this.products = [];
    this.inventory = { items: {}, purchases: [], sales: [], returns: [], daigous: [] };
    this.debts = [];
    this.warnings = [];
  }

  init() {
    ensureDir(this.dataDir);
    ensureDir(this.vouchersDir);
    if (!fs.existsSync(this.metaFile)) writeFileAtomic(this.metaFile, JSON.stringify(defaultMeta(), null, 2));
    if (!fs.existsSync(this.accountsFile)) writeFileAtomic(this.accountsFile, JSON.stringify({ accounts: [] }, null, 2));
    if (!fs.existsSync(this.categoriesFile)) {
      writeFileAtomic(this.categoriesFile, JSON.stringify({ categories: seedCategories() }, null, 2));
    }
    if (!fs.existsSync(this.loansFile)) writeFileAtomic(this.loansFile, JSON.stringify({ loans: [] }, null, 2));
    if (!fs.existsSync(this.plansFile)) writeFileAtomic(this.plansFile, JSON.stringify({ plans: [] }, null, 2));
    if (!fs.existsSync(this.productsFile)) writeFileAtomic(this.productsFile, JSON.stringify({ products: [] }, null, 2));
    if (!fs.existsSync(this.inventoryFile)) {
      writeFileAtomic(
        this.inventoryFile,
        JSON.stringify({ items: {}, purchases: [], sales: [], returns: [], daigous: [] }, null, 2),
      );
    }
    if (!fs.existsSync(this.debtsFile)) writeFileAtomic(this.debtsFile, JSON.stringify({ debts: [] }, null, 2));
    this.load();
    if ((this.meta.config.categorySchemaVersion || 0) >= 2 && ensureSeedCategories(this.categories).length) {
      this.saveCategories();
    }
    if (normalizeAccounts(this.accounts)) this.saveAccounts();
    return this;
  }

  load() {
    this.meta = readJson(this.metaFile, defaultMeta());
    const loadedConfig = this.meta.config || {};
    this.meta.config = { ...defaultMeta().config, ...loadedConfig };
    this.meta.config.categorySchemaVersion = loadedConfig.categorySchemaVersion ?? 0;
    this.accounts = readJson(this.accountsFile, { accounts: [] }).accounts || [];
    this.categories = readJson(this.categoriesFile, { categories: [] }).categories || [];
    this.loans = readJson(this.loansFile, { loans: [] }).loans || [];
    this.plans = readJson(this.plansFile, { plans: [] }).plans || [];
    this.products = readJson(this.productsFile, { products: [] }).products || [];
    this.inventory = readJson(this.inventoryFile, {
      items: {},
      purchases: [],
      sales: [],
      returns: [],
      daigous: [],
    });
    this.inventory.items ||= {};
    this.inventory.purchases ||= [];
    this.inventory.sales ||= [];
    this.inventory.returns ||= [];
    this.inventory.daigous ||= [];
    this.debts = readJson(this.debtsFile, { debts: [] }).debts || [];
    return this;
  }

  saveMeta() {
    writeFileAtomic(this.metaFile, JSON.stringify(this.meta, null, 2));
  }

  saveAccounts() {
    writeFileAtomic(this.accountsFile, JSON.stringify({ accounts: this.accounts }, null, 2));
  }

  saveCategories() {
    writeFileAtomic(this.categoriesFile, JSON.stringify({ categories: this.categories }, null, 2));
  }

  saveLoans() {
    writeFileAtomic(this.loansFile, JSON.stringify({ loans: this.loans }, null, 2));
  }

  savePlans() {
    writeFileAtomic(this.plansFile, JSON.stringify({ plans: this.plans }, null, 2));
  }

  saveProducts() {
    writeFileAtomic(this.productsFile, JSON.stringify({ products: this.products }, null, 2));
  }

  saveInventory() {
    writeFileAtomic(this.inventoryFile, JSON.stringify(this.inventory, null, 2));
  }

  saveDebts() {
    writeFileAtomic(this.debtsFile, JSON.stringify({ debts: this.debts }, null, 2));
  }

  monthFile(month) {
    return path.join(this.vouchersDir, `${month}.jsonl`);
  }

  listMonths() {
    if (!fs.existsSync(this.vouchersDir)) return [];
    return fs
      .readdirSync(this.vouchersDir)
      .filter((file) => /^\d{4}-\d{2}\.jsonl$/.test(file))
      .map((file) => file.slice(0, 7))
      .sort();
  }

  readMonth(month) {
    const file = this.monthFile(month);
    if (!fs.existsSync(file)) return [];
    const vouchers = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        vouchers.push(JSON.parse(line));
      } catch {
        this.warnings.push(`${month}.jsonl 里有一行读不懂，先跳过了：${line.slice(0, 40)}…`);
      }
    }
    return vouchers;
  }

  vouchers(month) {
    const months = month ? [month] : this.listMonths();
    const all = [];
    for (const current of months) all.push(...this.readMonth(current));
    all.sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        String(a.createdAt).localeCompare(String(b.createdAt)),
    );
    return all;
  }

  findVoucher(id) {
    for (const month of this.listMonths()) {
      const voucher = this.readMonth(month).find((candidate) => candidate.id === id);
      if (voucher) return { voucher, month };
    }
    return null;
  }

  appendVoucher(voucher) {
    const month = voucher.date.slice(0, 7);
    const list = this.readMonth(month);
    if (list.some((candidate) => candidate.id === voucher.id)) {
      throw new Error(`单据 ${voucher.id} 已经存在`);
    }
    list.push(voucher);
    writeFileAtomic(this.monthFile(month), list.map((item) => JSON.stringify(item)).join('\n') + '\n');
    this.audit({ action: 'post', voucherId: voucher.id, date: voucher.date, at: new Date().toISOString() });
    return voucher;
  }

  replaceVoucher(voucher, oldDate) {
    const oldMonth = oldDate.slice(0, 7);
    const newMonth = voucher.date.slice(0, 7);

    if (oldMonth === newMonth) {
      const list = this.readMonth(newMonth);
      const index = list.findIndex((candidate) => candidate.id === voucher.id);
      if (index < 0) throw new Error(`找不到单据 ${voucher.id}`);
      list[index] = voucher;
      writeFileAtomic(this.monthFile(newMonth), list.map((item) => JSON.stringify(item)).join('\n') + '\n');
      return voucher;
    }

    const oldList = this.readMonth(oldMonth).filter((candidate) => candidate.id !== voucher.id);
    writeFileAtomic(this.monthFile(oldMonth), oldList.map((item) => JSON.stringify(item)).join('\n') + '\n');
    const newList = this.readMonth(newMonth);
    newList.push(voucher);
    writeFileAtomic(this.monthFile(newMonth), newList.map((item) => JSON.stringify(item)).join('\n') + '\n');
    return voucher;
  }

  audit(entry) {
    ensureDir(this.dataDir);
    fs.appendFileSync(this.auditFile, JSON.stringify(entry) + '\n', 'utf8');
  }

  nextVoucherId(date) {
    return `v_${date.replaceAll('-', '')}_${randomUUID().slice(0, 8)}`;
  }
}
