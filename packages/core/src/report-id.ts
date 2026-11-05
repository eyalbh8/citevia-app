// Public handles are reversible record identifiers. All authorization still uses the resolved record.
const prefix = 'cvh_';
const identifier = /^[a-z0-9_-]+$/i;

function encodePart(part: string): string {
  if (!identifier.test(part) || (!/demo/i.test(part) && !part.startsWith(prefix))) return part;
  return prefix + Array.from(part, character => character.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

export function publicReportId(value: string): string {
  return value.split('~').map(encodePart).join('~');
}

export function resolveReportId(value: string): string {
  return value.split('~').map(part => {
    if (!part.startsWith(prefix)) return part;
    const hex = part.slice(prefix.length);
    if (!/^(?:[0-9a-f]{2}){1,200}$/.test(hex)) return part;
    const raw = String.fromCharCode(...hex.match(/../g)!.map(byte => Number.parseInt(byte, 16)));
    return identifier.test(raw) && encodePart(raw) === part ? raw : part;
  }).join('~');
}
