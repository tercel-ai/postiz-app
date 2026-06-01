'use client';

import { useEffect, useRef, useMemo } from 'react';
import useSWR from 'swr';
import DrawChart from 'chart.js/auto';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface ImpressionsPoint {
  date: string;
  value: number;
  platform: string;
}

const PERIOD = 'daily';
const PLATFORM_COLORS: Record<string, { line: string; fill: string }> = {
  x: { line: 'rgba(163, 230, 53, 1)', fill: 'rgba(163, 230, 53, 0.15)' },
  reddit: { line: 'rgba(251, 146, 60, 1)', fill: 'rgba(251, 146, 60, 0.15)' },
};
const FALLBACK_COLOR = { line: 'rgba(96, 165, 250, 1)', fill: 'rgba(96, 165, 250, 0.15)' };

export function EngageImpressionsPanel() {
  const fetch = useFetch();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<DrawChart | null>(null);

  const { data, isLoading } = useSWR(
    `/engage/dashboard/impressions?period=${PERIOD}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`engage/dashboard/impressions returned ${res.status}`);
      return res.json() as Promise<ImpressionsPoint[]>;
    }
  );

  const chartData = useMemo(() => {
    const points = data ?? [];
    if (!points.length) return null;

    const platforms = [...new Set(points.map((p) => p.platform))].sort();
    const dates = [...new Set(points.map((p) => p.date))].sort();

    const datasets = platforms.map((platform) => {
      const colors = PLATFORM_COLORS[platform] ?? FALLBACK_COLOR;
      const dateMap = new Map<string, number>();
      for (const p of points) {
        if (p.platform === platform) dateMap.set(p.date, p.value);
      }
      return {
        label: platform === 'x' ? 'X' : platform.charAt(0).toUpperCase() + platform.slice(1),
        data: dates.map((d) => dateMap.get(d) ?? null),
        borderColor: colors.line,
        backgroundColor: colors.fill,
        fill: true,
        tension: 0.2,
        pointRadius: 1,
        pointHoverRadius: 4,
        borderWidth: 1.5,
      };
    });

    return { dates, datasets };
  }, [data]);

  useEffect(() => {
    if (!canvasRef.current || !chartData) return;

    chartRef.current?.destroy();

    chartRef.current = new DrawChart(canvasRef.current, {
      type: 'line',
      data: {
        labels: chartData.dates,
        datasets: chartData.datasets,
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false,
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              color: '#9CA3AF',
              boxWidth: 12,
              boxHeight: 2,
              padding: 12,
              font: { size: 11 },
              usePointStyle: true,
            },
          },
          tooltip: {
            backgroundColor: '#1F2937',
            titleColor: '#F9FAFB',
            bodyColor: '#D1D5DB',
            borderColor: '#374151',
            borderWidth: 1,
            padding: 8,
            cornerRadius: 6,
            titleFont: { size: 11 },
            bodyFont: { size: 10 },
            callbacks: {
              label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y?.toLocaleString() ?? 0}`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#6B7280',
              font: { size: 9 },
              maxTicksLimit: 7,
              maxRotation: 0,
            },
            border: { display: false },
          },
          y: {
            display: false,
            beginAtZero: true,
          },
        },
        layout: {
          padding: { top: 0, bottom: 0, left: 0, right: 0 },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
    };
  }, [chartData]);

  const totalImpressions = useMemo(
    () => (data ?? []).reduce((s, p) => s + p.value, 0),
    [data]
  );

  if (isLoading) {
    return (
      <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748] animate-pulse h-48" />
    );
  }

  if (!data?.length) return null;

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-lime-500/20">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white">
          Engage Impressions
        </h3>
        <span className="text-xs text-gray-500">
          {totalImpressions.toLocaleString()} total
        </span>
      </div>
      <div className="h-[180px] w-full">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}
