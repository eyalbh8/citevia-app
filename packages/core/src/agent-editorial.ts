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

/** Recognize reply-style prefaces without rejecting useful lines such as "No shortcuts to better reporting." */
export function hasConversationalOpening(
  value: string,
  skipHeadings = false,
): boolean {
  let text = value.normalize('NFKC').replace(/[’‘]/g, "'");
  if (skipHeadings) {
    const lines = text
      .split('\n')
      .filter(
        (line) =>
          line.trim() &&
          !/^\s*(?:#{1,6}\s|<h[1-6]\b|(?:[-*_]\s*){3,}$)/i.test(line),
      );
    text = lines.join('\n') || text;
  }
  text = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_`~]/g, '');
  text = text
    .replace(/^\s*(?:[-*>]\s*|\d+[.)]\s+)+/u, '')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim();
  text = text.replace(/^TL;?DR\s*:\s*/i, '').trim();
  // Match complete acknowledgements, not words such as Yesterday, Surely or Noteworthy.
  const boundary = '(?=$|[\\s,.!?:;"\'”»])';
  const acknowledgement = new RegExp(
    '^(?:yes|yep|yeah|nope|nah|sure|absolutely|certainly|definitely|indeed|of course|not necessarily|not at all|you bet|here you go|hi|hello|hey|כן|בטח|בוודאי|כמובן|בהחלט|sí|oui|bien sûr|claro|por supuesto)' +
      boundary,
    'iu',
  );
  if (acknowledgement.test(text)) return true;
  if (
    /^(?:no|לא)(?=$|[,!.?:;]|\s+(?:you|it|they|we|this|that|there|the|I)\b)/iu.test(
      text,
    )
  )
    return true;
  return /^(?:(?:great|good|excellent) question|thanks for asking|thank you for (?:asking|your question)|to answer your question|in response to your question|as requested|as an AI|you(?:'re| are) (?:right|correct)|let me (?:explain|help|answer)|I(?:'d| would) be happy to|happy to help|I can help|it depends|(?:the )?(?:short|quick|direct) answer|here(?:'s| is) (?:(?:the|your) answer|(?:a|the|your) (?:(?:creative|standalone|social) )?(?:post|caption|article))|below is (?:a|the|your) (?:post|caption|article)|answer\s*:)(?=$|[^\p{L}\p{N}])/iu.test(
    text,
  );
}
