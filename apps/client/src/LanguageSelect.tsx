const codes =
  `af am ar az be bg bn bs ca cs cy da de el en eo es et eu fa fi fil fr ga gl gu he hi hr hu hy id is it ja ka kk km kn ko lo lt lv mk ml mn mr ms mt ne nl no pa pl ps pt ro ru sk sl so sq sr sv sw ta te th tr uk ur uz vi yi zh zu en-GB en-US pt-BR pt-PT zh-CN zh-TW`.split(
    ' ',
  );
const names = new Intl.DisplayNames(['en'], { type: 'language' });
export const LANGUAGE_OPTIONS = codes
  .map((code) => ({ code, label: `${names.of(code) || code} (${code})` }))
  .sort((a, b) => a.label.localeCompare(b.label, 'en'));

/** Visible names are labels; the controlled value is always the API language code. */
export default function LanguageSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  return (
    <select
      required
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {LANGUAGE_OPTIONS.map((option) => (
        <option key={option.code} value={option.code}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
