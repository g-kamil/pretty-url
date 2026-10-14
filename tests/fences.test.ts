import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCardFences } from '../src/fences';

test('keeps column choices local to each fence, including identical card bodies', () => {
  const section = ['```url-cards c=3', 'https://example.com', '```', '', '```url-cards', 'https://example.com', '```', '', '```url-cards c=1', 'https://example.com', '```'].join('\n');
  assert.deepEqual(parseCardFences(section), [{ columns: 3 }, {}, { columns: 1 }]);
});

test('rejects zero, negative, fractional, missing, nonnumeric, unsafe, and repeated column values', () => {
  for (const option of ['c=0', 'c=-1', 'c=1.5', 'c=', 'c=three', 'c=Infinity', 'c=9007199254740992', 'c=2 c=3']) {
    const [fence] = parseCardFences('```url-cards ' + option + '\nhttps://example.com\n```');
    assert.equal(fence.columns, undefined, option);
    assert.ok(fence.error, option);
  }
});

test('does not treat nested fence examples or description text as grid declarations', () => {
  const section = '````markdown\n```url-cards c=8\nhttps://example.com\n```\n````\n\n````url-cards c=2\nhttps://example.com\n  ```url-cards c=9\n````';
  assert.deepEqual(parseCardFences(section), [{ columns: 2 }]);
});

test('supports quoted, indented, tilde, and longer fences with whitespace around options', () => {
  const section = '> [!note]\r\n> ~~~~url-cards\tc=2\r\n> https://example.com\r\n> ~~~~\r\n\r\n- ```url-cards   c=3  \r\n  https://example.com\r\n  ```\r\n\r\n  ````url-cards c=1\r\n  https://example.com\r\n  ````';
  assert.deepEqual(parseCardFences(section), [{ columns: 2 }, { columns: 3 }, { columns: 1 }]);
});
