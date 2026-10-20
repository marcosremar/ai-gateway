import { useEffect, useMemo, useRef, useState } from 'react';

const TARGET_FPS = 60;
const FRAME_BUDGET_MS = 1000 / TARGET_FPS;
const SAMPLE_SIZE = 180;
const UPDATE_INTERVAL_MS = 500;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

function getDeviceLabel() {
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);

  if (isIOS) return 'iOS real';
  if (isMobile) return 'Mobile real';
  return 'Desktop medindo alvo iPhone 12';
}

function getMemoryMb() {
  const memory = performance.memory;
  if (!memory) return null;

  return Math.round(memory.usedJSHeapSize / 1024 / 1024);
}

function getLoadScore({ avgFrameMs, p95FrameMs, droppedPercent, longTasks }) {
  const avgPressure = Math.max(0, (avgFrameMs - 8) / 12);
  const p95Pressure = Math.max(0, (p95FrameMs - FRAME_BUDGET_MS) / 20);
  const dropPressure = droppedPercent / 20;
  const longTaskPressure = Math.min(1, longTasks / 8);

  return Math.min(
    100,
    Math.round((avgPressure * 35 + p95Pressure * 35 + dropPressure * 20 + longTaskPressure * 10) * 100),
  );
}

function getVerdict({ fps, p95FrameMs, droppedPercent, loadScore }) {
  if (fps >= 55 && p95FrameMs <= 20 && droppedPercent <= 3 && loadScore < 35) {
    return { label: 'OK iPhone 12', level: 'good' };
  }

  if (fps >= 45 && p95FrameMs <= 28 && droppedPercent <= 10 && loadScore < 65) {
    return { label: 'No limite', level: 'warn' };
  }

  return { label: 'Pesado', level: 'bad' };
}

export default function PerformanceMonitor() {
  const frameTimesRef = useRef([]);
  const droppedFramesRef = useRef(0);
  const totalFramesRef = useRef(0);
  const longTasksRef = useRef(0);
  const animationFrameRef = useRef(0);
  const lastFrameRef = useRef(0);
  const lastUpdateRef = useRef(0);
  const [stats, setStats] = useState({
    fps: 0,
    avgFrameMs: 0,
    p95FrameMs: 0,
    droppedPercent: 0,
    longTasks: 0,
    memoryMb: null,
    loadScore: 0,
  });

  const deviceLabel = useMemo(getDeviceLabel, []);
  const verdict = getVerdict(stats);

  useEffect(() => {
    let observer;

    if ('PerformanceObserver' in window) {
      try {
        observer = new PerformanceObserver((list) => {
          longTasksRef.current += list.getEntries().length;
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        observer = null;
      }
    }

    function tick(now) {
      if (lastFrameRef.current > 0) {
        const frameMs = now - lastFrameRef.current;
        const frameTimes = frameTimesRef.current;

        frameTimes.push(frameMs);
        if (frameTimes.length > SAMPLE_SIZE) frameTimes.shift();

        totalFramesRef.current += 1;
        if (frameMs > FRAME_BUDGET_MS * 1.5) droppedFramesRef.current += 1;
      }

      lastFrameRef.current = now;

      if (now - lastUpdateRef.current >= UPDATE_INTERVAL_MS) {
        const frameTimes = frameTimesRef.current;
        const totalFrameMs = frameTimes.reduce((sum, value) => sum + value, 0);
        const avgFrameMs = frameTimes.length ? totalFrameMs / frameTimes.length : 0;
        const fps = avgFrameMs ? Math.min(TARGET_FPS, 1000 / avgFrameMs) : 0;
        const droppedPercent = totalFramesRef.current
          ? (droppedFramesRef.current / totalFramesRef.current) * 100
          : 0;
        const nextStats = {
          fps,
          avgFrameMs,
          p95FrameMs: percentile(frameTimes, 0.95),
          droppedPercent,
          longTasks: longTasksRef.current,
          memoryMb: getMemoryMb(),
          loadScore: 0,
        };

        nextStats.loadScore = getLoadScore(nextStats);
        setStats(nextStats);
        lastUpdateRef.current = now;
      }

      animationFrameRef.current = requestAnimationFrame(tick);
    }

    animationFrameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationFrameRef.current);
      if (observer) observer.disconnect();
    };
  }, []);

  return (
    <aside className={`performance-monitor performance-monitor--${verdict.level}`}>
      <div className="performance-monitor__header">
        <span>Monitor</span>
        <strong>{verdict.label}</strong>
      </div>

      <div className="performance-monitor__score">
        <span>Peso</span>
        <strong>{stats.loadScore}/100</strong>
      </div>

      <dl className="performance-monitor__grid">
        <div>
          <dt>FPS</dt>
          <dd>{stats.fps.toFixed(0)}</dd>
        </div>
        <div>
          <dt>Frame medio</dt>
          <dd>{stats.avgFrameMs.toFixed(1)}ms</dd>
        </div>
        <div>
          <dt>P95 frame</dt>
          <dd>{stats.p95FrameMs.toFixed(1)}ms</dd>
        </div>
        <div>
          <dt>Quedas</dt>
          <dd>{stats.droppedPercent.toFixed(1)}%</dd>
        </div>
        <div>
          <dt>Travadas</dt>
          <dd>{stats.longTasks}</dd>
        </div>
        <div>
          <dt>Memoria</dt>
          <dd>{stats.memoryMb ? `${stats.memoryMb}MB` : 'n/d'}</dd>
        </div>
      </dl>

      <p className="performance-monitor__target">{deviceLabel} · alvo 60 FPS / 16.7ms</p>
    </aside>
  );
}
