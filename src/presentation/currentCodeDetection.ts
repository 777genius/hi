export function textLooksLikeCurrentCode(text: string): boolean {
  const raw = String(text ?? '');
  if (raw.includes('```')) return true;

  const lower = raw.toLowerCase();
  if (lower.includes('select ') && lower.includes(' from ')) return true;

  const hasCodePunctuation =
    raw.includes('{') ||
    raw.includes(';') ||
    raw.includes('=>') ||
    raw.includes('=') ||
    raw.includes('()') ||
    raw.includes('):') ||
    raw.includes(') {') ||
    /\w+\s*\([^)]*\)\s*[:{]/.test(raw);
  if (!hasCodePunctuation) return false;

  return [
    'function ',
    'class ',
    'interface ',
    'struct ',
    'impl ',
    'const ',
    'let ',
    'var ',
    'def ',
    'func ',
    'export ',
    'import ',
    'type ',
  ].some((marker) => lower.includes(marker));
}
