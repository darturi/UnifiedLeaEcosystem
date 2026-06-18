import assert from 'node:assert/strict';
import test from 'node:test';

import { renderTex } from './lib/mathRenderer.js';
import { parseInlineMarkdown, parseMarkdownBlocks } from './lib/markdownParser.js';

test('parses inline math delimiters', () => {
  const segments = parseInlineMarkdown('Show \\( n^2 \\) and $k + 1$.');

  assert.deepEqual(
    segments.filter((segment) => segment.type === 'math').map((segment) => segment.text),
    [' n^2 ', 'k + 1'],
  );
});

test('parses display math blocks', () => {
  const blocks = parseMarkdownBlocks('Before\n\n\\[\na^2 + b^2 = c^2\n\\]\n\nAfter');

  assert.equal(blocks[1].type, 'math');
  assert.equal(blocks[1].display, true);
  assert.equal(blocks[1].text, 'a^2 + b^2 = c^2');
});

test('does not parse math inside fenced code', () => {
  const blocks = parseMarkdownBlocks('```lean\n#check $x$\n```');

  assert.deepEqual(blocks, [{ type: 'code', text: '#check $x$', language: 'lean' }]);
});

test('does not parse math inside inline code', () => {
  const segments = parseInlineMarkdown('Use `$x$` literally.');

  assert.deepEqual(segments, [
    { type: 'text', text: 'Use ' },
    { type: 'code', text: '$x$' },
    { type: 'text', text: ' literally.' },
  ]);
});

test('keeps existing markdown segments', () => {
  const segments = parseInlineMarkdown('**Bold** and *em* with `code` and [link](https://example.com).');

  assert.deepEqual(
    segments.filter((segment) => segment.type !== 'text').map((segment) => segment.type),
    ['strong', 'emphasis', 'code', 'link'],
  );
});

test('renders valid TeX with KaTeX', () => {
  const rendered = renderTex('n^2', false);

  assert.equal(rendered.ok, true);
  assert.match(rendered.html, /katex/);
  assert.match(rendered.html, /n/);
});

test('falls back for invalid TeX', () => {
  const rendered = renderTex('\\notacommand{', false);

  assert.equal(rendered.ok, false);
  assert.equal(rendered.text, '\\notacommand{');
});
