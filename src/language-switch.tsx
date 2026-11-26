import type { Locale } from './i18n'
import { languagePath } from './language'

export function LanguageSwitch({
  locale,
  returnPath,
  consentToken,
}: {
  locale: Locale
  returnPath?: string
  consentToken?: string
}) {
  const next = locale === 'en' ? 'fr' : 'en'
  return (
    <form class="forge-language-switch" action={languagePath} method="post">
      {returnPath !== undefined && <input type="hidden" name="return" value={returnPath} />}
      {consentToken !== undefined && <input type="hidden" name="consent" value={consentToken} />}
      <button
        class="forge-button forge-language-switch__button"
        type="submit"
        name="language"
        value={next}
        lang={next}
        aria-label={next === 'fr' ? 'Français' : 'English'}
      >
        {next.toUpperCase()}
      </button>
    </form>
  )
}
