import { useEffect } from 'react';
import { ArrowLeft, ArrowUpRight, FileText } from 'lucide-react';
import type { Project } from '@citevia/core';
import { useApi } from './api';
import { Empty, ErrorNotice, Logo } from './components';
import { Skeleton } from './Loading';
import './demo-content.css';

export function readDemoContentPath(pathname: string): { projectId: string; slug: string } | null {
  const match = pathname.match(/^\/demo-content\/([^/]+)\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    const projectId = decodeURIComponent(match[1]), slug = decodeURIComponent(match[2]);
    return /^[a-zA-Z0-9_-]{1,160}$/.test(projectId) && /^[a-z0-9][a-z0-9-]{0,180}$/.test(slug)
      ? { projectId, slug } : null;
  } catch { return null; }
}

function referenceUrl(value: string) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

/** Demo posts remain behind the same account permissions as their reporting data. */
export default function DemoContentView({ projectId, slug }: { projectId: string; slug: string }) {
  const project = useApi<Project>(`/projects/${encodeURIComponent(projectId)}/settings`);
  const pathname = `/demo-content/${projectId}/${slug}`;
  const post = project.data?.demo?.source === 'website-demo'
    ? project.data.demo.trackedUrls?.find(item => item.demoPost && item.provenance?.kind === 'demo-draft'
      && item.url === `https://app.citevia.io${pathname}`)
    : undefined;
  useEffect(() => { document.title = post ? `${post.title} · Citevia demo` : 'Demo content · Citevia'; }, [post]);
  const references = [...new Set(post?.provenance?.sourceUrls || [])].flatMap(value => {
    const url = referenceUrl(value); return url ? [url] : [];
  });
  function selectAccount() {
    try { localStorage.setItem('citevia.project', projectId); } catch { /* storage unavailable */ }
  }
  return (
    <main className="demo-article-page">
      <header className="demo-article-header"><Logo /><span><FileText size={15} />Demo content</span></header>
      <article className="demo-article">
        <a className="demo-article-back" href="/#mentions" onClick={selectAccount}><ArrowLeft size={16} />Back to Mentions</a>
        <ErrorNotice error={project.error} />
        {project.loading && !project.data ? <Skeleton variant="detail" rows={3} label="Loading demo article…" />
          : post ? <>
            <p className="demo-article-brand">{project.data!.name}</p>
            <h1>{post.title}</h1>
            <p className="demo-article-meta"><time dateTime={post.publishedAt}>{new Date(post.publishedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}</time><span>Sample blog post</span></p>
            <aside className="demo-article-note">This article, its publication date, and its citation activity are part of the {project.data!.name} demo scenario.</aside>
            <div className="demo-article-body">{post.body?.split(/\n\s*\n/).filter(Boolean).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
            {references.length > 0 && <section className="demo-article-references"><h2>Company and topic references</h2><ul>{references.map(url => <li key={url}><a href={url} target="_blank" rel="noopener noreferrer">{url.replace(/^https:\/\//, '')}<ArrowUpRight size={14} /></a></li>)}</ul></section>}
          </> : !project.error && <Empty title="Demo article unavailable" description="Open a sample article from the account’s tracked content." />}
      </article>
    </main>
  );
}
