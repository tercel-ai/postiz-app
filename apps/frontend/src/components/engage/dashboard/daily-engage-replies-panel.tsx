'use client';

import { useEffect, useRef } from 'react';
import useSWR from 'swr';
import DrawChart from 'chart.js/auto';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

interface DailyItem {
  date: string;
  count: number;
  x: number;
  reddit: number;
}

interface DailyRepliesResponse {
  days: number;
  items: DailyItem[];
}

const DAYS = 30;

function formatDate(dateStr: string): string {
  // "2026-05-29" → "05/29"
  return dateStr.slice(5);
}

export function DailyEngageRepliesPanel() {
  const fetch = useFetch();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<DrawChart | null>(null);

  const { data, isLoading } = useSWR(
    `/engage/dashboard/replies-trend?days=${DAYS}`,
    async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`engage/dashboard/replies-trend returned ${res.status}`);
      return res.json() as Promise<DailyRepliesResponse>;
    }
  );

  const items = data?.items ?? [];
  const totalReplies = items.reduce((s, i) => s + i.count, 0);

  useEffect(() => {
    if (!canvasRef.current || !items.length) return;

    // Destroy previous chart instance before creating new one
    chartRef.current?.destroy();

    const labels = items.map((i) => formatDate(i.date));
    const xData = items.map((i) => i.x);
    const redditData = items.map((i) => i.reddit);

    chartRef.current = new DrawChart(canvasRef.current, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'X',
            data: xData,
            backgroundColor: 'rgba(163, 230, 53, 0.8)', // lime-400
            borderColor: 'rgba(163, 230, 53, 1)',
            borderWidth: 0,
            borderRadius: 2,
            barPercentage: 0.8,
            categoryPercentage: 0.9,
          },
          {
            label: 'Reddit',
            data: redditData,
            backgroundColor: 'rgba(251, 146, 60, 0.8)', // orange-400
            borderColor: 'rgba(251, 146, 60, 1)',
            borderWidth: 0,
            borderRadius: 2,
            barPercentage: 0.8,
            categoryPercentage: 0.9,
          },
        ],
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
              color: '#9CA3AF', // gray-400
              boxWidth: 10,
              boxHeight: 10,
              padding: 12,
              font: { size: 11 },
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
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: { display: false },
            ticks: {
              color: '#6B7280', // gray-500
              font: { size: 9 },
              maxTicksLimit: 7,
              maxRotation: 0,
            },
            border: { display: false },
          },
          y: {
            stacked: true,
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
  }, [items]);

  if (isLoading) {
    return (
      <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748] animate-pulse h-48" />
    );
  }

  if (!items.length || totalReplies === 0) {
    return null;
  }

  return (
    <div className="bg-[#1a2035] rounded-xl p-5 border border-[#2d3748]">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white">
          Daily Engage Replies
        </h3>
        <span className="text-xs text-gray-500">
          Last {DAYS} days · {totalReplies} total
        </span>
      </div>
      <div className="h-[180px] w-full">
        <canvas ref={canvasRef} className="w-full h-full" />
      </div>
    </div>
  );
}
