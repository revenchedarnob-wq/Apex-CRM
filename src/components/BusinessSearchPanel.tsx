import React, { useEffect, useState } from 'react';
import { useLeads } from '../context/LeadContext';

type BusinessSearchResponse = {
  leads: Array<{ id: string; business?: { name: string; pageUrl?: string; category?: string; city?: string; followers?: number; ownerName?: string }; reviewStatus?: string; evidenceReasons?: string[] }>;
  rejected: Array<{ name: string; pageUrl?: string; reasons: string[] }>;
  progress: string[];
  pagesConfigured: boolean;
  stats: { pagesFound: number; pagesRead: number; pagesFromCache: number; qualified: number; maybe: number; rejected: number; saved?: { created: number; updated: number; duplicates: number }; searchErrors: string[] };
};

/** Discover tab: find small and local businesses through their public Facebook Pages (beta). */
export default function BusinessSearchPanel() {
  const { rehydrateLeads } = useLeads();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BusinessSearchResponse | null>(null);
  const [config, setConfig] = useState<{ search: boolean; pages: boolean } | null>(null);

  useEffect(() => {
    fetch('/api/find-businesses/status')
      .then((res) => (res.ok ? res.json() : null))
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const run = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim() || running) return;
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/find-businesses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), limit }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Search failed (${res.status})`);
      setResult(data as BusinessSearchResponse);
      await rehydrateLeads(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={run} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3">
        <label htmlFor="business-brief" className="block text-sm font-semibold text-white">
          What businesses are you looking for? <span className="ml-1 rounded bg-sky-500/20 px-1.5 py-0.5 text-xs text-sky-300">Beta</span>
        </label>
        <textarea
          id="business-brief"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          rows={2}
          maxLength={2000}
          placeholder="Bakeries in Manchester with over 500 followers that do wedding cakes"
          className="w-full rounded-lg border border-slate-700 bg-slate-950 p-2 text-sm text-white"
        />
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="business-limit" className="text-sm text-slate-400">How many</label>
          <input
            id="business-limit"
            type="number"
            min={1}
            max={100}
            value={limit}
            onChange={(e) => setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            className="w-20 rounded-lg border border-slate-700 bg-slate-950 p-1.5 text-sm text-white"
          />
          <button
            type="submit"
            disabled={running || !query.trim()}
            className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {running ? 'Searching…' : 'Find businesses'}
          </button>
        </div>
        {config && !config.search && (
          <p className="text-sm text-amber-300">No web search provider is set up. Add TAVILY_API_KEY to .env.</p>
        )}
        {config && config.search && !config.pages && (
          <p className="text-sm text-slate-400">BRIGHTDATA_API_TOKEN is not set, so businesses are judged from search results only.</p>
        )}
      </form>

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

      {result && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 space-y-3" aria-live="polite">
          <p className="text-sm text-slate-300">
            Found {result.stats.pagesFound} Pages, kept {result.leads.length} ({result.stats.qualified} qualified, {result.stats.maybe} to review), rejected {result.stats.rejected}.
            {result.stats.saved && ` ${result.stats.saved.created} new in your CRM.`}
          </p>
          <ul className="divide-y divide-slate-800">
            {result.leads.map((lead) => (
              <li key={lead.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  {lead.business?.pageUrl ? (
                    <a href={lead.business.pageUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-sky-300 hover:underline">
                      {lead.business?.name}
                    </a>
                  ) : (
                    <span className="font-semibold text-white">{lead.business?.name}</span>
                  )}
                  {lead.reviewStatus === 'MAYBE' && <span className="rounded bg-amber-500/20 px-1.5 text-xs text-amber-300">Review</span>}
                </div>
                <p className="text-slate-400">
                  {[lead.business?.category, lead.business?.city, lead.business?.ownerName && `Owner: ${lead.business.ownerName}`].filter(Boolean).join(' · ')}
                </p>
                {lead.evidenceReasons?.length ? <p className="text-xs text-slate-500">{lead.evidenceReasons.join('; ')}</p> : null}
              </li>
            ))}
          </ul>
          {result.stats.searchErrors.length > 0 && (
            <p className="text-xs text-amber-300">Some searches failed: {result.stats.searchErrors.slice(0, 3).join('; ')}</p>
          )}
        </div>
      )}
    </div>
  );
}
