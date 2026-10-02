import { useMemo } from 'react';
import ReactMarkdown, { type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { mathRehypePlugins, prepareMathMarkdown, remarkBackslashMath, remarkDisplayDollars, remarkMath } from '../lib/math-markdown';
import 'katex/dist/katex.min.css';
import './math-markdown.css';

export default function MathMarkdown({ children = '', ...props }: Omit<Options, 'remarkPlugins' | 'rehypePlugins'>) {
  const prepared = useMemo(() => prepareMathMarkdown(children || ''), [children]);
  return <ReactMarkdown {...props}
    remarkPlugins={[remarkGfm, remarkMath, remarkDisplayDollars, [remarkBackslashMath, prepared.slots]]}
    rehypePlugins={[...mathRehypePlugins.map(([plugin, options]) => [plugin, options] as [typeof plugin, typeof options]), rehypeHighlight]}>
    {prepared.source}
  </ReactMarkdown>;
}
