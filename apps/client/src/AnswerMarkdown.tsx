import { hasRestrictedDestination, publicSourceUrl } from '@citevia/core';
import type { ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './answers.css';
import { isReportTextBoundary, reportExcerptParts } from './report-excerpt';

type TreeNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, string>;
  children?: TreeNode[];
};

// Compute display text and its attribution together, after parsing destinations.
function reportBody() {
  return (tree: TreeNode) => {
    let omitted = false;
    let inline: TreeNode[] = [];
    function flush() {
      const values = inline.map(node => node.value ?? '');
      const excerpts = reportExcerptParts(values);
      if (excerpts !== values) {
        omitted = true;
        inline.forEach((node, index) => { node.value = excerpts[index]; });
      }
      inline = [];
    }
    function visit(node: TreeNode) {
      const boundary = isReportTextBoundary(node.tagName);
      if (boundary) flush();
      if (node.type === 'text') inline.push(node);
      if (node.tagName === 'a' && node.properties?.href && hasRestrictedDestination(node.properties.href)) omitted = true;
      if (node.tagName === 'img') {
        // Only alt text is shown. The image destination is never displayed or fetched.
        node.type = 'text';
        node.value = node.properties?.alt || '';
        inline.push(node);
      }
      node.children?.forEach(visit);
      if (boundary) flush();
    }
    visit(tree); flush();
    tree.children = [{ type: 'element', tagName: 'div', properties: { dataReportBody: omitted ? 'excerpt' : 'full' }, children: tree.children }];
  };
}

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
  renderReport,
}: {
  text: string;
  aliases?: string[];
  preview?: boolean;
  renderReport?: (content: ReactNode, omitted: boolean) => ReactNode;
}) {
  return (
      <Markdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[reportBody, highlightBrands(aliases)]}
        components={{
          div: ({ node, children, ...props }) => {
            const kind = node?.properties.dataReportBody;
            if (!kind) return <div {...props}>{children}</div>;
            const content = <div className={`answer-markdown${preview ? ' answer-preview' : ''}`} dir="auto">{children}</div>;
            return renderReport ? renderReport(content, kind === 'excerpt') : content;
          },
          a: ({ href, children }) =>
            !preview && href && (publicSourceUrl(href) || (href.startsWith('#') && !hasRestrictedDestination(href))) ? (
              <a
                href={href.startsWith('#') ? href : publicSourceUrl(href) ?? undefined}
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
  );
}
