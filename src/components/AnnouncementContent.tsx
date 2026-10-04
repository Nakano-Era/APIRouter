import MathMarkdown from './MathMarkdown';

export default function AnnouncementContent({ children }: { children: string }) {
  return <div className="markdown announcement-markdown"><MathMarkdown skipHtml components={{
    a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
    img: ({ alt }) => <span>{alt ? `［图片：${alt}］` : '［图片］'}</span>,
    table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
  }}>{children}</MathMarkdown></div>;
}
