// Устойчивое к транслитерации сравнение текста эталона и распознанного STT-текста.
// STT (ru/uk модель) пишет английские термины кириллицей ("Рейлс", "постгрескл"),
// поэтому сравниваем "консонантные скелеты": транслитерация -> латиница -> без гласных.

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'e', ж: 'z', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c',
  ш: 's', щ: 's', ы: 'i', э: 'e', ю: 'u', я: 'a', ь: '', ъ: '', ё: 'e',
};

export function skeleton(word) {
  // Repeated digits carry meaning: 11 must never collapse to 1.
  if (/^\d+$/.test(String(word))) return String(word);
  let out = '';
  for (const ch of String(word).toLowerCase()) {
    if (ch in CYR) out += CYR[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
  }
  out = out.replaceAll('x', 'ks').replaceAll('q', 'k').replaceAll('w', 'v').replaceAll('c', 'k').replaceAll('y', 'i').replaceAll('j', 'i');
  out = out.replaceAll('h', '').replace(/[aeiou]/g, '');
  return out.replace(/(.)\1+/g, '$1');
}

// Exact RU/UK cardinal forms, including common grammatical cases. Only valid
// descending hundred -> tens -> ones groups are combined, never adjacent ones.
const NUMBER_FORMS = [
  [0, 'ноль нуль нуля'], [1, 'один одна одно одне одну одного однієї одной'],
  [2, 'два две дві двох двух двом двум'], [3, 'три трьох трех трём трьом'],
  [4, 'чотири четыре чотирьох четырех'], [5, 'пять пяти пятью пятьма пятеро пятьох пяти'], [6, 'шість шести шістьох шесть шестью'],
  [7, 'сім семи сімох семь семью'], [8, 'вісім восьми вісьмох восемь восемью'],
  [9, 'девять девяти девятьох девятью'], [10, 'десять десяти десятьох десятью'],
  [11, 'одинадцять одинадцяти одиннадцать одиннадцати'],
  [12, 'дванадцять дванадцяти двенадцать двенадцати'],
  [13, 'тринадцять тринадцяти тринадцать тринадцати'],
  [14, 'чотирнадцять чотирнадцяти четырнадцать четырнадцати'],
  [15, 'пятнадцять пятнадцяти пятнадцать пятнадцати'],
  [16, 'шістнадцять шістнадцяти шестнадцать шестнадцати'],
  [17, 'сімнадцять сімнадцяти семнадцать семнадцати'],
  [18, 'вісімнадцять вісімнадцяти восемнадцать восемнадцати'],
  [19, 'девятнадцять девятнадцяти девятнадцать девятнадцати'],
  [20, 'двадцять двадцяти двадцать двадцати'], [30, 'тридцять тридцяти тридцать тридцати'],
  [40, 'сорок сорока'], [50, 'пятдесят пятдесяти пятьдесят пятидесяти'],
  [60, 'шістдесят шістдесяти шестьдесят шестидесяти'],
  [70, 'сімдесят сімдесяти семьдесят семидесяти'],
  [80, 'вісімдесят вісімдесяти восемьдесят восьмидесяти'],
  [90, 'девяносто девяноста'], [100, 'сто ста'], [200, 'двісті двохсот двести двухсот'],
  [300, 'триста трьохсот трехсот'], [400, 'чотириста чотирьохсот четыреста четырехсот'],
  [500, 'пятсот пятьсот пятисот'], [600, 'шістсот шестисот шестьсот'],
  [700, 'сімсот семисот семьсот'], [800, 'вісімсот восьмисот восемьсот'],
  [900, 'девятсот девятьсот девятисот'],
];
const NUMBERS = new Map(NUMBER_FORMS.flatMap(([value, forms]) => forms.split(' ').map((form) => [form, value])));

function unit(word) {
  if (/^(?:hz|гц|гцах|герц(?:а|ів|ев|ы|и|ах|ами|ові|ам)?)$/.test(word)) return 'hz';
  if (/^(?:ms|мс|мілісекунд(?:а|и|у|і|ах|ами)?|миллисекунд(?:а|ы|и|у|е|ах|ами)?)$/.test(word)) return 'ms';
  return word;
}

export function words(text) {
  const tokens = String(text || '').toLowerCase()
    .replace(/['’ʼ]/g, '')
    .replace(/[^a-zа-яіїєґё0-9 ]+/g, ' | ')
    .split(/\s+/).filter(Boolean);
  const result = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '|') continue;
    const first = NUMBERS.get(tokens[i]);
    if (first === undefined) { result.push(unit(tokens[i])); continue; }
    let value = first;
    let previous = first;
    while (i + 1 < tokens.length) {
      const next = NUMBERS.get(tokens[i + 1]);
      const valid = next !== undefined && next > 0 &&
        ((previous >= 100 && next < 100) || (previous >= 20 && previous < 100 && next < 10));
      if (!valid) break;
      value += next;
      previous = next;
      i += 1;
    }
    result.push(String(value));
  }
  return result;
}

function trigrams(str) {
  const m = new Map();
  for (let i = 0; i + 3 <= str.length; i += 1) {
    const g = str.slice(i, i + 3);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

/** Доля триграмм эталона (по скелету), найденных в распознанном тексте: 0..1. Лишний текст не штрафуется. */
export function coverage(reference, hypothesis) {
  const refWords = words(reference);
  const hypWords = words(hypothesis);
  // Correct surrounding prose must not disguise a changed or missing quantity.
  // Extra hypothesis text remains unpenalized, including additional quantities.
  const remainingNumbers = hypWords.filter((word) => /^\d+$/.test(word));
  for (const number of refWords.filter((word) => /^\d+$/.test(word))) {
    const index = remainingNumbers.indexOf(number);
    if (index < 0) return 0;
    remainingNumbers.splice(index, 1);
  }
  const ref = trigrams(refWords.map(skeleton).join(''));
  const hyp = trigrams(hypWords.map(skeleton).join(''));
  let total = 0;
  let hit = 0;
  for (const [g, n] of ref) {
    total += n;
    hit += Math.min(n, hyp.get(g) || 0);
  }
  return total ? hit / total : 1;
}
