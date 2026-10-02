import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import type { Root, RootContent, Text } from 'mdast';
import type { Plugin } from 'unified';

type MathSlot = { marker: string; value: string; display: boolean };
export type PreparedMath = { source: string; slots: MathSlot[] };
const rangeParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);
const protectedTypes = new Set(['code', 'inlineCode', 'link', 'linkReference', 'image', 'imageReference', 'definition', 'html', 'inlineMath', 'math']);

function escaped(source: string, index: number) {
  let previous = index - 1;
  while (previous >= 0 && source[previous] === '\\') previous--;
  return (index - previous - 1) % 2 === 1;
}

/** Prepare presentation only. Stored message text, clipboard and exports keep the original source. */
export function prepareMathMarkdown(source: string): PreparedMath {
  if (!/\\[([]/.test(source)) return { source, slots: [] };
  const ranges: Array<[number, number]> = [];
  const collect = (node: Root | RootContent) => {
    if (protectedTypes.has(node.type) && node.position) {
      ranges.push([node.position.start.offset!, node.position.end.offset!]);
    } else if ('children' in node) {
      for (const child of node.children) collect(child as RootContent);
    }
  };
  collect(rangeParser.parse(source));
  let prefix = 'APIRouterMathSlot';
  while (source.includes(prefix)) prefix += 'X';
  const slots: MathSlot[] = [];
  const parts: string[] = [];
  const opening = /\\[([]/g;
  let copied = 0;
  for (let match = opening.exec(source); match; match = opening.exec(source)) {
    const start = match.index;
    if (escaped(source, start) || ranges.some(([from, to]) => from <= start && start < to)) continue;
    const display = source[start + 1] === '[';
    const closing = display ? '\\]' : '\\)';
    let end = source.indexOf(closing, start + 2);
    while (end !== -1 && escaped(source, end)) end = source.indexOf(closing, end + 2);
    if (end === -1) continue; // An unfinished streamed delimiter remains ordinary text.
    if (ranges.some(([from, to]) => from < end + 2 && to > start)) continue;
    const value = source.slice(start + 2, end).trim();
    if (!value) continue;
    const marker = `${prefix}${slots.length}End`;
    slots.push({ marker, value, display });
    parts.push(source.slice(copied, start), marker);
    copied = end + 2;
    opening.lastIndex = copied;
  }
  if (!slots.length) return { source, slots };
  parts.push(source.slice(copied));
  return { source: parts.join(''), slots };
}

/** Slots become math nodes after Markdown parsing, so TeX punctuation cannot turn into Markdown. */
export const remarkBackslashMath: Plugin<[MathSlot[]], Root> = slots => tree => {
  if (!slots.length) return;
  const byMarker = new Map(slots.map(slot => [slot.marker, slot]));
  const markerPattern = new RegExp(slots.map(slot => slot.marker).join('|'), 'g');
  const replace = (node: Root | RootContent) => {
    if (!('children' in node) || protectedTypes.has(node.type)) return;
    const next: RootContent[] = [];
    for (const child of node.children) {
      if (child.type !== 'text') { replace(child as RootContent); next.push(child as RootContent); continue; }
      let copied = 0;
      for (const match of child.value.matchAll(markerPattern)) {
        if (match.index > copied) next.push({ type: 'text', value: child.value.slice(copied, match.index) } as Text);
        const slot = byMarker.get(match[0])!;
        next.push({ type: 'inlineMath', value: slot.value, data: {
          hName: 'code', hProperties: { className: ['language-math', slot.display ? 'math-display' : 'math-inline'] },
          hChildren: [{ type: 'text', value: slot.value }],
        } });
        copied = match.index + match[0].length;
      }
      if (!copied) next.push(child);
      else if (copied < child.value.length) next.push({ type: 'text', value: child.value.slice(copied) } as Text);
    }
    node.children = next as typeof node.children;
  };
  replace(tree);
};

// Model replies commonly put $$...$$ on one line. Markdown otherwise treats
// these as inline math, although the author requested a display equation.
export const remarkDisplayDollars: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file.value);
  const visit = (node: Root | RootContent) => {
    if (node.type === 'inlineMath' && node.position) {
      const raw = source.slice(node.position.start.offset, node.position.end.offset);
      if (raw.startsWith('$$') && raw.endsWith('$$')) node.data = { ...node.data,
        hProperties: { ...node.data?.hProperties, className: ['language-math', 'math-display'] },
      };
    } else if ('children' in node && !protectedTypes.has(node.type)) {
      for (const child of node.children) visit(child as RootContent);
    }
  };
  visit(tree);
};

// rehype-katex catches parsing errors and retries with throwOnError:false; it deliberately
// owns that option. Never enable trusted HTML/URLs, global macros or unbounded expansion.
export const mathRehypePlugins = [[rehypeKatex, {
  trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20,
  errorColor: '#d97777', output: 'htmlAndMathml',
}]] as const;

export { remarkMath };
