export interface CardFence {
  columns?: number;
  error?: string;
}

/** Read actual url-cards fences, not lookalike text inside other code blocks. */
export function parseCardFences(section: string): CardFence[] {
  const result: CardFence[] = [];
  let delimiter = '';
  let length = 0;
  for (const line of section.split(/\r?\n/)) {
    const fence = /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (!fence) continue;
    if (delimiter) {
      if (fence[1][0] === delimiter && fence[1].length >= length && !fence[2].trim()) delimiter = '';
      continue;
    }
    delimiter = fence[1][0];
    length = fence[1].length;
    const [language, ...options] = fence[2].trim().split(/\s+/);
    if (language !== 'url-cards') continue;
    const columns = options.filter(option => option.startsWith('c='));
    if (!columns.length) {
      result.push({});
      continue;
    }
    const value = columns[0].slice(2);
    const count = Number(value);
    if (columns.length !== 1 || !/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1) {
      result.push({ error: 'Columns must be a positive integer, for example c=3. Specify c= only once.' });
    } else {
      result.push({ columns: count });
    }
  }
  return result;
}
