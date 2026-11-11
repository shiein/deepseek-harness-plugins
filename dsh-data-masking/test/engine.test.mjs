import assert from 'node:assert/strict';
import test from 'node:test';
import { Masker, Vault, compileRules, defaultRules, normalizeRules, patternError, previewOf, unresolvedTokens } from '../host/engine.js';

const SECRET = Buffer.alloc(32, 7);

function rulesWith(overrides = {}) {
  const rules = defaultRules();
  rules.enabled = true;
  rules.categories.find((c) => c.code === 'REGION').terms = ['华东大区', '华东'];
  rules.categories.find((c) => c.code === 'DEPT').terms = ['风控二部', '风控'];
  rules.categories.find((c) => c.code === 'PERSON').terms = ['张三丰'];
  rules.categories.find((c) => c.code === 'ADDR').terms = ['杭州市西湖区文三路90号'];
  rules.patterns = [{ id: 'emp', code: 'EMPID', label: '员工号段', regex: 'EMP-88\\d{4}' }];
  return normalizeRules({ ...rules, ...overrides });
}

function mask(text, rules = rulesWith()) {
  const matcher = compileRules(rules, SECRET);
  const masker = new Masker(matcher);
  const vault = new Vault(matcher);
  const hits = [];
  return { out: masker.maskText(text, vault, hits), hits, vault, matcher, masker };
}

test('longest term wins and categories are kept', () => {
  const { out, hits } = mask('华东大区的风控二部与华东的风控');
  assert.equal(hits.map((h) => h.value).join('|'), '华东大区|风控二部|华东|风控');
  assert.match(out, /^\{\{REGION_[0-9a-f]{6}\}\}的\{\{DEPT_[0-9a-f]{6}\}\}与\{\{REGION_[0-9a-f]{6}\}\}的\{\{DEPT_[0-9a-f]{6}\}\}$/);
  assert.ok(!out.includes('华东') && !out.includes('风控'));
});

test('placeholders are deterministic across vaults and differ per value', () => {
  const a = mask('张三丰 EMP-881234').out;
  const b = mask('张三丰 EMP-881234').out;
  assert.equal(a, b);
  const c = mask('EMP-889999').out;
  assert.notEqual(a.split(' ')[1], c);
});

test('pattern rule, allowlist and existing placeholders', () => {
  const rules = rulesWith({ allowlist: ['风控'] });
  const { out, hits } = mask('工号 EMP-881234 属于风控，风控二部', rules);
  assert.deepEqual(hits.map((h) => h.code), ['EMPID', 'DEPT']);
  assert.ok(out.includes('属于风控，'));
  // A term that happens to equal a placeholder's code must not be masked inside the placeholder.
  const tricky = normalizeRules({ ...rulesWith(), categories: [{ id: 't', code: 'TERM', label: '术语', terms: ['DEPT'] }] });
  const already = mask('see {{DEPT_abcdef}} and DEPT', tricky);
  assert.equal(already.out.startsWith('see {{DEPT_abcdef}} and {{TERM_'), true);
});

test('builtins: id card checksum, phone, email with example domains skipped', () => {
  const rules = rulesWith({ builtins: { idcard: true, phone: true, email: true } });
  const { hits } = mask('身份证 11010519491231002X 错误 110105194912310021 手机 13812345678 邮箱 a.b@corp.cn x@example.com', rules);
  assert.deepEqual(hits.map((h) => h.code), ['IDCARD', 'PHONE', 'EMAIL']);
});

test('JSON tool arguments: values masked, keys and structure preserved', () => {
  const { masker, matcher } = mask('');
  const vault = new Vault(matcher);
  const hits = [];
  const raw = JSON.stringify({ path: 'a.txt', content: '负责人张三丰\n"风控二部"', n: 1 });
  const out = JSON.parse(masker.maskJson(raw, vault, hits));
  assert.equal(out.path, 'a.txt');
  assert.equal(out.n, 1);
  assert.match(out.content, /^负责人\{\{PERSON_[0-9a-f]{6}\}\}\n"\{\{DEPT_[0-9a-f]{6}\}\}"$/);
  assert.equal(masker.maskJson('{"a":"nothing"}', vault, []), '{"a":"nothing"}');
});

test('validation rejects broken rules instead of dropping them', () => {
  assert.throws(() => normalizeRules({ patterns: [{ code: 'X', label: 'bad', regex: '(' }] }), /无法编译/);
  assert.throws(() => normalizeRules({ patterns: [{ code: 'X', label: 'empty', regex: 'a*' }] }), /空字符串/);
  assert.throws(() => normalizeRules({ patterns: [{ code: 'X', label: 'redos', regex: '(a+)+b' }] }), /嵌套/);
  assert.throws(() => normalizeRules({ categories: [{ code: '1-bad', label: 'x', terms: [] }] }), /代号/);
  assert.throws(() => normalizeRules({ categories: [{ code: 'A', label: 'x' }, { code: 'A', label: 'y' }] }), /重复/);
  assert.equal(patternError('EMP-\\d+'), null);
});

test('vault resolves collisions by lengthening the token', () => {
  const matcher = { tokenFor: (code, value, length) => `{{${code}_${'a'.repeat(length - 1)}${length > 6 ? value.length % 10 : 'a'}}}` };
  const vault = new Vault(matcher);
  const first = vault.token('X', 'one');
  const second = vault.token('X', 'three');
  assert.notEqual(first, second);
  assert.equal(vault.valueOf(first), 'one');
  assert.equal(vault.valueOf(second), 'three');
  assert.equal(vault.token('X', 'one'), first);
});

test('unresolved tokens and previews', () => {
  const { out, vault, matcher } = mask('张三丰');
  assert.deepEqual(unresolvedTokens(`${out} {{PERSON_000000}} {{OTHER_000000}}`, vault, matcher.codes), ['{{PERSON_000000}}']);
  assert.equal(previewOf('张三丰'), '张**');
  assert.equal(previewOf('EMP-881234'), 'EM********');
  assert.equal(previewOf('A'), '*');
});

test('memo is bounded by entries and total characters', () => {
  const matcher = compileRules(rulesWith(), SECRET);
  const masker = new Masker(matcher, { memoLimit: 5, memoChars: 400 });
  const vault = new Vault(matcher);
  for (let i = 0; i < 50; i += 1) masker.maskText(`张三丰 ${'x'.repeat(i * 3)} ${i}`, vault, []);
  assert.ok(masker.memo.size <= 5);
  assert.ok(masker.memoSize <= 400);
  assert.equal(masker.memoSize, [...masker.memo.keys()].reduce((sum, key) => sum + key.length, 0));
  const unmemo = new Masker(matcher, { memoLimit: 0 });
  assert.match(unmemo.maskText('张三丰', vault, []), /^\{\{PERSON_/);
  assert.equal(unmemo.memo.size, 0);
});
