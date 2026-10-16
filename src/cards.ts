export interface UrlCard {
  url: string;
  title: string;
  description: string;
}

export interface CardError {
  line: number;
  message: string;
}

export interface CardParseResult {
  cards: UrlCard[];
  errors: CardError[];
}

/** Only web URLs become navigable cards. Never reinterpret a relative path. */
export function webUrl(value: string): URL | null {
  if (!/^https?:\/\//i.test(value) || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname && (url.protocol === 'https:' || url.protocol === 'http:') ? url : null;
  } catch {
    return null;
  }
}

/** Labels are plain text; HTML and Markdown are never executed. */
export function parseCardLine(line: string): UrlCard | null {
  const value = line.trim().replace(/^(?:[-+*]\s+|\d+[.)]\s+)/, '');
  let destination = value;
  let title = '';
  const link = /^\[((?:\\.|[^\]\\])*)\]\((.*)\)$/.exec(value);
  if (link) {
    title = link[1].replace(/\\([\\[\]])/g, '$1').trim();
    destination = link[2];
  }
  if (destination.startsWith('<') && destination.endsWith('>')) {
    destination = destination.slice(1, -1);
  }
  const url = webUrl(destination);
  if (!url) return null;
  return { url: url.href, title: title || url.hostname, description: '' };
}

/** One URL per line, with optional indented plain-text description lines. */
export function parseCards(source: string): CardParseResult {
  const cards: UrlCard[] = [];
  const errors: CardError[] = [];
  let current: UrlCard | undefined;
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const card = parseCardLine(line);
    if (card) {
      cards.push(card);
      current = card;
    } else if (/^(?: {2}|\t)[ \t]*\S/.test(line) && current) {
      current.description += (current.description ? '\n' : '') + line.trim();
    } else {
      errors.push({ line: index + 1, message: 'Expected an http(s) URL or [Title](https://example.com).' });
      current = undefined;
    }
  }
  return { cards, errors };
}

export function cardsToBlock(cards: UrlCard[]): string {
  const lines = cards.map(card => {
    const title = card.title.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    const entry = `[${title}](<${card.url}>)`;
    return card.description ? entry + '\n' + card.description.split('\n').map(line => '  ' + line).join('\n') : entry;
  });
  const content = lines.join('\n\n');
  let fenceLength = 3;
  for (const match of content.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
  const fence = '`'.repeat(fenceLength);
  return fence + 'url-cards\n' + content + '\n' + fence;
}
