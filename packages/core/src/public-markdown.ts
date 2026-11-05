import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmFromMarkdown, gfmToMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { decodeString } from 'micromark-util-decode-string';
import { publicReportText, publicReportTextParts, reportOmission } from './public-text.js';
import { hasRestrictedDestination, publicSourceUrl } from './urls.js';

type ReportNode = {
  type: string;
  children?: ReportNode[];
  value?: string;
  url?: string;
  identifier?: string;
  title?: string | null;
  alt?: string | null;
};

const extensions = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };
const writeOptions = { extensions: [gfmToMarkdown()] };
const inlineNodes = new Set(['text', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'inlineCode']);

function destination(url: string): string | null {
  if (/^https?:\/\//i.test(url)) return publicSourceUrl(url);
  // Relative links and in-document fragments are meaningful within Markdown.
  return hasRestrictedDestination(url) ? null : url;
}

/** Also remove a bare address from code, alt text, or the label of an autolink. */
function withoutBlockedAddresses(value: string) {
  return value.replace(/\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi, url => {
    const bare = /^www\./i.test(url);
    const safe = publicSourceUrl(bare ? 'https://' + url : url);
    return safe ? (bare ? safe.slice('https://'.length) : safe) : reportOmission;
  });
}

function mightNeedFiltering(value: string): boolean {
  if (hasRestrictedDestination(value) || /&(?:#\w+|[a-z]+);/i.test(value)) return true;
  // Formatting and nested elements can join pieces of one word in the rendered text.
  if (!/[*~`_<>[\\]/.test(value)) return false;
  return /demos?/i.test(value.replace(/<[^>]*>|\]\([^)]*\)|[*~`_\[\]\\]/g, ''));
}

/** Preserve original formatting unless an omission or first-party URL upgrade is required. */
export function publicReportMarkdown(value: string): string {
  if (!mightNeedFiltering(value)) return value;
  if (!/[&*~`_<>[\\%]/.test(value) && !/(?:https?:\/\/|www\.)/i.test(value)) return publicReportText(value);

  const tree = fromMarkdown(value, extensions);
  const blocked = new Set<string>();
  let changed = false;
  function findDefinitions(node: ReportNode) {
    if (node.type === 'definition' && node.identifier && node.url && !destination(node.url)) {
      blocked.add(node.identifier);
    }
    node.children?.forEach(findDefinitions);
  }
  findDefinitions(tree);

  let leaves: ReportNode[] = [];
  function flush() {
    const before = leaves.map(leaf => leaf.value || '');
    const after = publicReportTextParts(before);
    if (after !== before) {
      changed = true;
      leaves.forEach((leaf, i) => { leaf.value = after[i]; });
    }
    leaves = [];
  }

  function visit(node: ReportNode): ReportNode[] {
    const inline = inlineNodes.has(node.type);
    if (!inline) flush();
    if (node.type === 'html' && node.value && hasRestrictedDestination(decodeString(node.value))) {
      // Raw HTML is unsupported in saved answers. Never turn an attribute into a different destination.
      changed = true;
      return [];
    }
    for (const key of ['value', 'title', 'alt'] as const) {
      const original = node[key];
      if (!original) continue;
      const addresses = withoutBlockedAddresses(original);
      const clean = key === 'value' && inline ? addresses : publicReportText(addresses);
      if (clean !== original) { node[key] = clean; changed = true; }
    }
    if (node.type === 'text' || node.type === 'inlineCode') leaves.push(node);
    if (node.children) node.children = node.children.flatMap(visit);
    if (!inline) flush();

    const url = node.url;
    const linked = node.type === 'linkReference' || node.type === 'imageReference';
    const safe = url ? destination(url) : undefined;
    if ((linked && blocked.has(node.identifier || '')) || safe === null) {
      changed = true;
      if (node.type === 'definition') return [];
      return node.children || [{ type: 'text', value: node.alt || reportOmission }];
    }
    if (safe && safe !== url) { node.url = safe; changed = true; }
    return [node];
  }
  visit(tree);
  flush();
  if (!changed) return publicReportText(value);
  return publicReportText(toMarkdown(tree, writeOptions).trimEnd().replaceAll('\\[…]', reportOmission));
}
