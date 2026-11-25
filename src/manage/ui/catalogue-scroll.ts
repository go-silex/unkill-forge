export const catalogueScrollScriptSource = "'sha256-4Vk1pW5T+fiuvkwpT+HAuWgtAiuyFo7T/wg566D+4sU='"

// The Manage CSP test hashes the exact script emitted in a catalogue response.
export const catalogueScrollScript = `(() => {
  const feed = document.querySelector('[data-catalogue-feed]');
  const results = feed.querySelector('[data-catalogue-results]');
  const link = feed.querySelector('.forge-page-link');
  if (!link || !('IntersectionObserver' in window)) return;
  const selector = feed.dataset.catalogueFeed === 'list' ? '.forge-table tbody' : '.forge-gallery';
  let busy = false;
  const observer = new IntersectionObserver(async ([entry]) => {
    if (!entry.isIntersecting || busy) return;
    busy = true;
    observer.unobserve(link);
    results.setAttribute('aria-busy', 'true');
    const next = link.href;
    try {
      const response = await fetch(next, { credentials: 'same-origin', mode: 'same-origin', redirect: 'manual' });
      if (!response.ok || response.redirected || !/^text\\/html(?:;|$)/i.test(response.headers.get('Content-Type') || '')) throw new Error();
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const incoming = page.querySelector('[data-catalogue-feed]');
      const content = incoming?.querySelector('[data-catalogue-results]');
      if (!content || incoming.dataset.catalogueFeed !== feed.dataset.catalogueFeed) throw new Error();
      const continuation = incoming.querySelector('.forge-page-link')?.getAttribute('href');
      if (continuation && new URL(continuation, next).href === next) throw new Error();
      const source = content.querySelector(selector);
      const target = results.querySelector(selector);
      if (source && target) {
        const seen = new Set(Array.from(target.children, (item) => item.querySelector('a[href]')?.getAttribute('href')));
        for (const item of Array.from(source.children)) {
          const href = item.querySelector('a[href]')?.getAttribute('href');
          if (!seen.has(href)) {
            seen.add(href);
            target.append(item);
          }
        }
      } else if (!target) {
        results.replaceChildren(...content.childNodes);
      }
      if (continuation) {
        link.href = new URL(continuation, next).href;
        // A fresh observation also fires when an empty page leaves the link in range.
        observer.observe(link);
      } else {
        if (document.activeElement === link) results.focus({ preventScroll: true });
        link.parentElement.remove();
      }
    } catch {
      location.assign(next);
    } finally {
      results.removeAttribute('aria-busy');
      busy = false;
    }
  }, { rootMargin: '0px 0px 300px' });
  observer.observe(link);
})();`
