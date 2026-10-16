import { useEffect, useState } from 'react';
import { FlagDetail } from './FlagDetail';
import { FlagList } from './FlagList';

function currentRoute(): string | null {
  const match = window.location.hash.match(/^#\/flags\/(.+)$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

export function App() {
  const [flagKey, setFlagKey] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => {
      setFlagKey(currentRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="22" height="22">
              <path d="M9 16.5l4.5 4.5L23 11" stroke="currentColor" strokeWidth="3.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          Verdict
        </a>
        <span className="tagline">Feature flags and A/B tests that tell you whether to ship</span>
      </header>
      <main className="container">{flagKey ? <FlagDetail flagKey={flagKey} /> : <FlagList />}</main>
    </>
  );
}
