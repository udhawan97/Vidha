import type { CycleStage, PlanState } from '@vidha/domain';
import { useEffect, useRef } from 'react';

interface ContinuityLineProps {
  readonly cycle: PlanState['cycle'];
}

const stageOrder: readonly CycleStage[] = [
  'on_time',
  'reminder',
  'overdue',
  'concern',
];

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en', {
    day: 'numeric',
    month: 'short',
  }).format(timestamp);
}

export function ContinuityLine({ cycle }: ContinuityLineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const currentPointRef = useRef<HTMLLIElement>(null);
  const currentIndex = stageOrder.indexOf(cycle.stage);
  const progress = (currentIndex / (stageOrder.length - 1)) * 100;
  const courierPosition = 12.5 + progress * 0.75;
  const points = [
    { label: 'Checked in', date: cycle.startedAt },
    { label: 'Reminder', date: cycle.reminderAt },
    { label: 'Due', date: cycle.dueAt },
    { label: 'Concern', date: cycle.concernAt },
  ];

  useEffect(() => {
    const scrollRegion = scrollRef.current;
    const currentPoint = currentPointRef.current;
    if (scrollRegion === null || currentPoint === null) {
      return;
    }

    const target =
      currentPoint.offsetLeft +
      currentPoint.offsetWidth / 2 -
      scrollRegion.clientWidth / 2;
    const left = Math.max(
      0,
      Math.min(target, scrollRegion.scrollWidth - scrollRegion.clientWidth),
    );
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = prefersReducedMotion ? 'auto' : 'smooth';

    if (typeof scrollRegion.scrollTo === 'function') {
      scrollRegion.scrollTo({ behavior, left });
    } else {
      scrollRegion.scrollLeft = left;
    }
  }, [currentIndex]);

  return (
    <div className="continuity-line">
      <div
        aria-label={`Current timeline stage: ${cycle.stage.replace('_', ' ')}`}
        className="continuity-scroll"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
          }

          event.preventDefault();
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          event.currentTarget.scrollLeft +=
            direction * Math.max(48, event.currentTarget.clientWidth * 0.25);
        }}
        ref={scrollRef}
        tabIndex={0}
      >
        <div className="continuity-canvas">
          <span
            className="continuity-courier"
            style={{ left: `${courierPosition}%` }}
            aria-hidden="true"
          >
            <picture>
              <source
                media="(prefers-color-scheme: dark)"
                srcSet="/vidha-mark-reversed.svg"
              />
              <img alt="" height="450" src="/vidha-mark.svg" width="600" />
            </picture>
          </span>
          <div className="continuity-track" aria-hidden="true">
            <span
              className="continuity-progress"
              style={{ width: `${progress}%` }}
            />
          </div>
          <ol>
            {points.map((point, index) => {
              const state =
                index < currentIndex
                  ? 'complete'
                  : index === currentIndex
                    ? 'current'
                    : 'future';
              return (
                <li
                  className={`continuity-point is-${state}`}
                  key={point.label}
                  ref={index === currentIndex ? currentPointRef : undefined}
                >
                  <span className="continuity-knot" aria-hidden="true" />
                  <span className="continuity-label">{point.label}</span>
                  <time dateTime={new Date(point.date).toISOString()}>
                    {formatDate(point.date)}
                  </time>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
      <p className="continuity-boundary">
        Release logic is not active in this build.
      </p>
    </div>
  );
}
