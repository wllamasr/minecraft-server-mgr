import DOMPurify from 'dompurify'

/**
 * Sanitize HTML that comes from a third party (e.g. a CurseForge mod
 * description) before it is injected into the page. The renderer holds the
 * privileged `window.api` bridge, so remote markup must never be able to run
 * script, load frames, or submit forms.
 */
export function sanitizeRemoteHtml(html: string): string {
  return DOMPurify.sanitize(html ?? '', {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style']
  })
}
