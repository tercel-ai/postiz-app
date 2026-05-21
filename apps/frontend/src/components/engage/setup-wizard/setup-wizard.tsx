'use client';

import { useState, useCallback } from 'react';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useRouter } from 'next/navigation';
import { useToaster } from '@gitroom/react/toaster/toaster';

const KEYWORD_TYPE_COLORS: Record<string, string> = {
  CORE: 'bg-blue-500/20 text-blue-400',
  BRAND: 'bg-green-500/20 text-green-400',
  COMPETITOR: 'bg-red-500/20 text-red-400',
};

export function SetupWizard() {
  const fetch = useFetch();
  const router = useRouter();
  const toaster = useToaster();

  const [keywords, setKeywords] = useState<
    Array<{ keyword: string; type: string; enabled: boolean }>
  >([]);
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const addKeyword = useCallback(() => {
    const kw = input.trim();
    if (!kw || keywords.some((k) => k.keyword === kw)) return;
    setKeywords((prev) => [...prev, { keyword: kw, type: 'CORE', enabled: true }]);
    setInput('');
  }, [input, keywords]);

  const removeKeyword = (idx: number) =>
    setKeywords((prev) => prev.filter((_, i) => i !== idx));

  const toggleKeyword = (idx: number) =>
    setKeywords((prev) =>
      prev.map((k, i) => (i === idx ? { ...k, enabled: !k.enabled } : k))
    );

  const handleSubmit = useCallback(async () => {
    if (!keywords.length) return;
    setSubmitting(true);
    try {
      // Save only enabled keywords
      for (const kw of keywords.filter((k) => k.enabled)) {
        await fetch('/engage/keywords', {
          method: 'POST',
          body: JSON.stringify({ keyword: kw.keyword, type: kw.type }),
        });
      }
      // Mark setup complete
      await fetch('/engage/config', {
        method: 'POST',
        body: JSON.stringify({ setupCompleted: true }),
      });
      toaster.show('Setup complete! Starting first scan...', 'success');
      router.push('/engage');
      router.refresh();
    } catch {
      toaster.show('Setup failed. Please try again.', 'warning');
    } finally {
      setSubmitting(false);
    }
  }, [keywords, fetch, router, toaster]);

  return (
    <div className="max-w-2xl mx-auto p-8">
      <div className="mb-8">
        <h2 className="text-2xl font-bold text-white mb-2">
          Welcome to Engage
        </h2>
        <p className="text-gray-400">
          Add keywords to start discovering relevant conversations. You can
          always add more in Settings.
        </p>
      </div>

      {/* Keyword input */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Keywords
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 bg-[#1e2536] border border-[#2d3748] text-white rounded-lg px-4 py-2 text-sm focus:outline-none focus:border-blue-500"
            placeholder="e.g. GEO, SEO tool, content strategy"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
          />
          <button
            onClick={addKeyword}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            Add
          </button>
        </div>
      </div>

      {/* Keyword list */}
      {keywords.length > 0 && (
        <div className="space-y-2 mb-8">
          {keywords.map((kw, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between bg-[#1e2536] rounded-lg px-4 py-3"
            >
              <div className="flex items-center gap-3">
                <span
                  className={`text-xs px-2 py-0.5 rounded font-medium ${
                    KEYWORD_TYPE_COLORS[kw.type]
                  }`}
                >
                  {kw.type}
                </span>
                <span className="text-white text-sm">{kw.keyword}</span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => toggleKeyword(idx)}
                  className={`text-xs ${
                    kw.enabled ? 'text-green-400' : 'text-gray-500'
                  }`}
                >
                  {kw.enabled ? 'ON' : 'OFF'}
                </button>
                <button
                  onClick={() => removeKeyword(idx)}
                  className="text-gray-500 hover:text-red-400 text-lg leading-none"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between pt-4 border-t border-[#1e2536]">
        <p className="text-sm text-gray-400">
          {keywords.filter((k) => k.enabled).length} keyword
          {keywords.filter((k) => k.enabled).length !== 1 ? 's' : ''} ready
        </p>
        <button
          onClick={handleSubmit}
          disabled={!keywords.length || submitting}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {submitting ? 'Setting up...' : '🚀 Start scanning'}
        </button>
      </div>
    </div>
  );
}
