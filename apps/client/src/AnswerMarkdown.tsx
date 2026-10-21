import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './answers.css';

type TreeNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, string>;
  children?: TreeNode[];
};

// Highlight text leaves after Markdown parsing, never markup, URLs or code.
function highlightBrands(aliases: string[]) {
  const names = [
    ...new Set(aliases.map((name) => name.trim()).filter(Boolean)),
  ].sort((a, b) => b.length - a.length);
  return () => (tree: TreeNode) => {
    if (!names.length) return;
    const escaped = names
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])(${escaped})(?![\\p{L}\\p{N}])`,
      'giu',
    );
    const matches = new Set(names.map((name) => name.toLocaleLowerCase()));
    function visit(node: TreeNode) {
      if (!node.children || ['code', 'pre'].includes(node.tagName || ''))
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) {
          visit(child);
          return [child];
        }
        return child.value
          .split(pattern)
          .filter(Boolean)
          .map((value) =>
            matches.has(value.toLocaleLowerCase())
              ? {
                  type: 'element',
                  tagName: 'mark',
                  properties: {},
                  children: [{ type: 'text', value }],
                }
              : { type: 'text', value },
          );
      });
    }
    visit(tree);
  };
}

export default function AnswerMarkdown({
  text,
  aliases = [],
  preview = false,
}: {
  text: string;
  aliases?: string[];
  preview?: boolean;
}) {
  return (
    <div
      className={`answer-markdown${preview ? ' answer-preview' : ''}`}
      dir="auto"
    >
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[highlightBrands(aliases)]}
        components={{
          a: ({ href, children }) =>
            !preview && href && /^(https?:\/\/|#)/i.test(href) ? (
              <a
                href={href}
                target={href.startsWith('#') ? undefined : '_blank'}
                rel="noreferrer noopener"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt }) => <span>{alt}</span>,
          table: ({ children }) => (
            <div className="answer-table-scroll">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
