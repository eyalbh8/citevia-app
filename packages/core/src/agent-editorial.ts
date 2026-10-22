/** Keep legacy body media out of previews, exports and structured article text. */
export function blogBodyText(body: string): string {
  return body
    .replace(/\[\[example-[12]\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^\n]*?\)/g, '')
    .replace(/!\[[^\]]*\]\s*\[[^\]]*\]/g, '')
    .replace(
      /<(?:figure|picture|svg)\b[^>]*>[\s\S]*?<\/(?:figure|picture|svg)>/gi,
      '',
    )
    .replace(/<(?:img|source)\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** URLs retain their exact spelling, including legitimate punctuation in paths. */
export function naturalPunctuation(value: string): string {
  return value
    .split(/(https?:\/\/[^\s)<>]+)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(/(\d)[\u2012-\u2015](?=\d)/g, '$1-')
            .replace(/\s*[\u2012-\u2015]\s*|\s+--+\s+/g, ', ')
            .replace(/,\s*([,.!?;:])/g, '$1'),
    )
    .join('');
}

export function descriptiveLinkLabel(label: string): boolean {
  const text = label.replace(/[*_~]/g, '').trim();
  return (
    text.length >= 3 &&
    !/^(?:https?:\/\/|www\.)/i.test(text) &&
    !/^(?:here|click here|learn more|read more|source|website)[.!]?$/i.test(
      text,
    )
  );
}
