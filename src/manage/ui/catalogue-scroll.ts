export const catalogueScrollScriptSource = "'sha256-dWrsf/FRx1v7Rmi1Aej9Q7WaZ1wsIVzjMQ6wYyJvM5I='"

// The Manage CSP test hashes the exact script emitted in a catalogue response.
export const catalogueScrollScript = `(() => {
  const feed = document.querySelector('[data-catalogue-feed]');
  const results = feed.querySelector('[data-catalogue-results]');
  const link = feed.querySelector('.forge-page-link');
  if (!link || !('IntersectionObserver' in window)) return;
  const selector = feed.dataset.catalogueFeed === 'list' ? '.forge-table tbody' : '.forge-gallery';
  const itemLink = (item) => item?.querySelector('a[href]');
  const shown = new Map(Array.from(results.querySelectorAll('[data-artefact-id]'), (item) => [item.dataset.artefactId, item]));
  let busy = false;
  const observer = new IntersectionObserver(async (entries) => {
    if (!entries.at(-1)?.isIntersecting || busy) return;
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
      let firstAppended;
      if (!target) results.replaceChildren(...content.childNodes);
      if (source) {
        for (const item of Array.from(source.children)) {
          const id = item.dataset.artefactId;
          const previous = shown.get(id);
          if (previous) {
            const focused = previous.contains(document.activeElement);
            previous.replaceWith(item);
            if (focused) itemLink(item)?.focus({ preventScroll: true });
          } else {
            target?.append(item);
            firstAppended ??= item;
          }
          shown.set(id, item);
        }
      }
      if (document.activeElement === link) {
        if (firstAppended) {
          itemLink(firstAppended)?.focus({ preventScroll: true });
        } else if (!continuation) {
          const lastItem = results.querySelector(selector)?.lastElementChild;
          (itemLink(lastItem) ?? results).focus({ preventScroll: true });
        }
      }
      if (continuation) {
        link.href = new URL(continuation, next).href;
        // A fresh observation also fires when an empty page leaves the link in range.
        observer.observe(link);
      } else {
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
