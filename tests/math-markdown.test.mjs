import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { mathRehypePlugins, prepareMathMarkdown, remarkBackslashMath, remarkDisplayDollars, remarkMath } from '../src/lib/math-markdown.ts';

function render(source) {
  const prepared = prepareMathMarkdown(source);
  return renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkMath, remarkDisplayDollars, [remarkBackslashMath, prepared.slots]],
    rehypePlugins: [...mathRehypePlugins, rehypeHighlight],
  }, prepared.source));
}
const occurrences = (html, value) => html.split(value).length - 1;

test('single-line double-dollar formulas are displayed equations while code stays literal', () => {
  const html = render('$$c^2=a^2+b^2$$\n\ninline $x$ and `$$literal$$`');
  assert.equal(occurrences(html, 'class="katex-display"'), 1);
  assert.equal(occurrences(html, 'class="katex"'), 2);
  assert.match(html, /<code>\$\$literal\$\$<\/code>/);
});

test('dollar and backslash delimiters render inline/display math without losing TeX punctuation', () => {
  const source = String.raw`余弦定理：\[c^2=a^2+b^2-2ab\cos C\] 当 \(C=90^\circ\) 时，$\cos C=0$。

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

\[\begin{pmatrix}a_1 & b^2 \\ c & d\end{pmatrix}\quad\text{面积}\]
`;
  const html = render(source);
  assert.equal(occurrences(html, 'class="katex"'), 5);
  assert.equal(occurrences(html, 'class="katex-display"'), 3);
  assert.match(html, /<math xmlns=/);
  assert.match(html, /c\^2=a\^2\+b\^2-2ab\\cos C/);
  assert.match(html, /面积/);
  assert.doesNotMatch(html, /katex-error|language-math|<pre/);
  assert.equal(source.includes(String.raw`\[c^2`), true, 'rendering does not rewrite the stored/copy source');
});

test('Markdown code, links, images, reference definitions and escaped delimiters are not normalized', () => {
  const protectedExamples = [
    '`' + String.raw`\(x\) \[y\] $z$` + '`',
    '```js\n' + String.raw`const tex = "\(x\)";` + '\n```',
    '~~~latex\n' + String.raw`\[c^2\]` + '\n~~~',
    '    ' + String.raw`\[c^2\]`,
    String.raw`[\(label\)](https://example.com/a\(b\))`,
    String.raw`![\[image\]](https://example.com/a.png)`,
    String.raw`[id]: https://example.com/\(x\) "\[title\]"`,
    String.raw`<span data-tex="\(x\)">HTML</span>`,
    String.raw`\\(literal\\) \\[literal\\]`,
    String.raw`$\text{\(literal\)}$`,
  ];
  for (const source of protectedExamples) {
    assert.equal(prepareMathMarkdown(source).source, source, source);
    assert.equal(prepareMathMarkdown(source).slots.length, 0, source);
  }
  const html = render('```js\n' + String.raw`const tex = "\(x\)";` + '\n```\n\n' + String.raw`真正的 \(x^2\)`);
  assert.equal(occurrences(html, 'class="katex"'), 1);
  assert.match(html, /<pre><code class="hljs language-js"/);
  assert.match(html, /\\\(x\\\)/);
});

test('ordinary brackets, currency, unfinished and invalid streamed math remain safe readable output', () => {
  for (const source of ['[c^2=a^2+b^2]', '(C=90^\\circ)', String.raw`价格为 \$5`, String.raw`还在生成 \(\frac{1}{`, String.raw`\[x+`, '$x+', '$$\n\\frac{']) {
    assert.doesNotThrow(() => render(source), source);
  }
  const plain = render('[c^2=a^2+b^2] (a,b,c)');
  assert.doesNotMatch(plain, /class="katex"/);
  const invalid = render(String.raw`\[\frac{\]`);
  assert.match(invalid, /katex-error/);
  assert.match(invalid, /\\frac\{/);
});

test('untrusted math cannot inject links, HTML, images, giant dimensions or infinite macros', () => {
  const html = render(String.raw`$\href{javascript:alert(1)}{click}$ $\includegraphics{https://evil.example/pixel}$ $\htmlClass{evil}{x}$ $\htmlStyle{background:url(https://evil.example)}{x}$`);
  assert.doesNotMatch(html, /<a\b|<img\b|class="evil"|style="background/);
  assert.doesNotThrow(() => render(String.raw`$\def\a{\a}\a$`));
  assert.match(render(String.raw`$\def\a{\a}\a$`), /katex-error/);
  const bounded = render(String.raw`$\rule{999999em}{999999em}$`);
  assert.doesNotMatch(bounded, /(?:width|height):999999em/);
  assert.match(bounded, /20em/);
  const isolated = render(String.raw`$\gdef\secret{LEAK}\secret$ $\secret$`);
  assert.equal(occurrences(isolated, '>LEAK<'), 0, 'KaTeX renders letters separately');
  assert.match(isolated, /color:#d97777/, 'a definition is not shared with the next formula');
});

test('math code fences render as formulas and marker-looking user text is preserved', () => {
  const html = render('```math\n' + String.raw`\sqrt{x^2+y^2}` + '\n```');
  assert.equal(occurrences(html, 'class="katex-display"'), 1);
  assert.doesNotMatch(html, /<pre|language-math/);
  const source = String.raw`APIRouterMathSlot0End \(x\) APIRouterMathSlotX0End`;
  const rendered = render(source);
  assert.match(rendered, /APIRouterMathSlot0End/);
  assert.match(rendered, /APIRouterMathSlotX0End/);
  assert.equal(occurrences(rendered, 'class="katex"'), 1);
});

test('inline formulas stay inside list/table formatting and adjacent formulas stay separate', () => {
  const html = render(String.raw`- \[x^2\] then \(y\)\(z\)

| 变量 | 公式 |
| --- | --- |
| C | \(90^\circ\) |
`);
  assert.match(html, /<ul>/); assert.match(html, /<table>/);
  assert.equal(occurrences(html, 'class="katex"'), 4);
});
