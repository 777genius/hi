import assert from 'node:assert/strict';
import test from 'node:test';
import { coverage, skeleton, words } from './sttMatch.mjs';

test('written Ukrainian quantities and units match actual numeric STT formatting', () => {
  const expected = 'При ста двадцяти герцах build триває дві мілісекунди, а кадри п’ятнадцять. Які перевірки проведете?';
  const actual = 'При 120 Гцах Build триває 2 мс, а кадри 15. Які перевірки проведете?';
  assert.equal(coverage(expected, actual), 1);
  assert.deepEqual(words('сто двадцять три герци, дві мілісекунди'), ['123', 'hz', '2', 'ms']);
  assert.deepEqual(words('двохсот тридцяти чотирьох герцах'), ['234', 'hz']);
});

test('Russian declensions, English unit abbreviations and apostrophe variants normalize', () => {
  assert.equal(coverage('При ста двадцати герцах кадр занимает две миллисекунды', 'При 120 Hz кадр занимает 2 ms'), 1);
  for (const apostrophe of ["'", '’', 'ʼ']) {
    assert.deepEqual(words(`п${apostrophe}ятнадцять дев${apostrophe}ять п${apostrophe}ятдесят`), ['15', '9', '50']);
  }
  assert.deepEqual(words('триста сорок один, девятьсот девяносто девять'), ['341', '999']);
  assert.deepEqual(words('нуль мс, одна мілісекунда, пять миллисекунд'), ['0', 'ms', '1', 'ms', '5', 'ms']);
});

test('wrong or missing quantities and corrupt content do not become successful matches', () => {
  const expected = 'При ста двадцяти герцах build триває дві мілісекунди';
  assert.equal(coverage(expected, 'При 60 Гц build триває 2 мс'), 0);
  assert.equal(coverage(expected, 'При 120 Гц build триває 20 мс'), 0);
  assert.equal(coverage(expected, 'При герцах build триває мілісекунди'), 0);
  assert.ok(coverage(expected, '120 2 зовсім інша випадкова відповідь') < 0.5);
  assert.equal(skeleton('11'), '11');
  assert.equal(coverage('одинадцять людей', '1 людей'), 0);
  assert.deepEqual(words('один два три, двадцять тридцять'), ['1', '2', '3', '20', '30']);
  assert.deepEqual(words('сто, двадцять, три'), ['100', '20', '3']);
});

test('transliteration and extra hypothesis text retain their existing matching contract', () => {
  assert.equal(coverage('Flutter', 'флаттер'), 1);
  assert.equal(coverage('два мілісекунди', '2 ms додатковий контекст 120 Hz'), 1);
});
