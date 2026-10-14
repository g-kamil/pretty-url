import assert from 'node:assert/strict';
import test from 'node:test';
import { cardsToBlock, parseCardLine, parseCards, webUrl } from '../src/cards';

test('accepts web URLs without promoting unsafe or relative destinations', () => {
  assert.equal(webUrl('https://example.com/a?q=x#part')?.href, 'https://example.com/a?q=x#part');
  for (const value of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/note', '//example.com', 'example.com', 'https://', 'https://exa mple.com', 'mailto:a@example.com']) {
    assert.equal(webUrl(value), null, value);
  }
});

test('keeps labels, escaped brackets, balanced URL parentheses, and encoded spaces', () => {
  assert.deepEqual(parseCardLine('- [A \\[label\\]](<https://example.com/a_(b)?q=hello%20world>)'), {
    title: 'A [label]', url: 'https://example.com/a_(b)?q=hello%20world', description: '',
  });
  assert.equal(parseCardLine('2. https://example.com/path')?.title, 'example.com');
  assert.equal(parseCardLine('<https://example.com>')?.url, 'https://example.com/');
});

test('attaches indented descriptions and reports exact invalid line numbers', () => {
  const result = parseCards('[First](https://one.example)\r\n  First line.\r\n    Second line.\r\n\r\njavascript:alert(1)\r\n  Orphan description\r\nhttps://two.example');
  assert.deepEqual(result.cards, [
    { title: 'First', url: 'https://one.example/', description: 'First line.\nSecond line.' },
    { title: 'two.example', url: 'https://two.example/', description: '' },
  ]);
  assert.deepEqual(result.errors.map(error => error.line), [5, 6]);
});

test('accepts deeper and mixed tab indentation without losing descriptions', () => {
  const { cards, errors } = parseCards('https://example.com\n\tTabbed\n\t\tDeeper\n\t  Mixed\n  \tSpaces first');
  assert.equal(cards[0].description, 'Tabbed\nDeeper\nMixed\nSpaces first');
  assert.deepEqual(errors, []);
});

test('does not discard duplicates or execute markup in supplied labels', () => {
  const { cards, errors } = parseCards('[<img src=x onerror=alert(1)>](https://example.com)\nhttps://example.com\nhttps://example.com');
  assert.equal(cards[0].title, '<img src=x onerror=alert(1)>');
  assert.equal(cards[1].url, cards[2].url);
  assert.deepEqual(errors, []);
});

test('selection serialization preserves escaped titles and descriptions', () => {
  const cards = [{ url: 'https://example.com/a_(b)', title: 'A [B] \\ C', description: 'One\nTwo' }];
  const block = cardsToBlock(cards);
  assert.deepEqual(parseCards(block.split('\n').slice(1, -1).join('\n')), { cards, errors: [] });
});

test('description backticks cannot close the generated Markdown fence', () => {
  const block = cardsToBlock([{ url: 'https://example.com/', title: 'Example', description: '```\nLiteral code fence' }]);
  const lines = block.split('\n');
  const openingFence = lines[0].replace('url-cards', '');
  assert.ok(openingFence.length > 3, 'The enclosing fence must exceed the literal description fence');
  assert.equal(lines.at(-1), openingFence);
});
