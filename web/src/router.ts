import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';

export type Route = { page: 'list' } | { page: 'settings' } | { page: 'flag'; key: string };

function parse(): Route {
  if (window.location.hash === '#/settings') return { page: 'settings' };
  const match = window.location.hash.match(/^#\/flags\/(.+)$/);
  return match ? { page: 'flag', key: decodeURIComponent(match[1]!) } : { page: 'list' };
}

export const flagHref = (key: string) => `#/flags/${encodeURIComponent(key)}`;

export function navigate(href: string): void {
  window.location.hash = href.replace(/^#/, '');
}

/**
 * Hash routing, with the browser-native View Transitions API animating the
 * swap between the list and detail views where it is supported.
 */
export function useRoute(): Route {
  const [route, setRoute] = useState(parse);

  useEffect(() => {
    const onChange = () => {
      const update = () => {
        flushSync(() => setRoute(parse()));
        window.scrollTo(0, 0);
      };
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (document.startViewTransition && !reduced) document.startViewTransition(update);
      else update();
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
