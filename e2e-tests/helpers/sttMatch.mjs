// Устойчивое к транслитерации сравнение текста эталона и распознанного STT-текста.
// STT (ru/uk модель) пишет английские термины кириллицей ("Рейлс", "постгрескл"),
// поэтому сравниваем "консонантные скелеты": транслитерация -> латиница -> без гласных.

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', є: 'e', ж: 'z', з: 'z', и: 'i', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c',
  ш: 's', щ: 's', ы: 'i', э: 'e', ю: 'u', я: 'a', ь: '', ъ: '', ё: 'e',
};

export function skeleton(word) {
  let out = '';
  for (const ch of String(word).toLowerCase()) {
    if (ch in CYR) out += CYR[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
  }
  out = out.replaceAll('x', 'ks').replaceAll('q', 'k').replaceAll('w', 'v').replaceAll('c', 'k').replaceAll('y', 'i').replaceAll('j', 'i');
  out = out.replaceAll('h', '').replace(/[aeiou]/g, '');
  return out.replace(/(.)\1+/g, '$1');
}

export function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-яіїєґё0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
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
  const ref = trigrams(words(reference).map(skeleton).join(''));
  const hyp = trigrams(words(hypothesis).map(skeleton).join(''));
  let total = 0;
  let hit = 0;
  for (const [g, n] of ref) {
    total += n;
    hit += Math.min(n, hyp.get(g) || 0);
  }
  return total ? hit / total : 1;
}
