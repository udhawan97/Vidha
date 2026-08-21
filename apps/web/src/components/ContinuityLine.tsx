import type { CycleStage, PlanState } from '@vidha/domain';

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
  const currentIndex = stageOrder.indexOf(cycle.stage);
  const points = [
    { label: 'Checked in', date: cycle.startedAt },
    { label: 'Reminder', date: cycle.reminderAt },
    { label: 'Due', date: cycle.dueAt },
    { label: 'Concern', date: cycle.concernAt },
  ];

  return (
    <div
      aria-label={`Current timeline stage: ${cycle.stage.replace('_', ' ')}`}
      className="continuity-line"
      tabIndex={0}
    >
      <div className="continuity-track" aria-hidden="true">
        <span
          className="continuity-progress"
          style={{ width: `${(currentIndex / (points.length - 1)) * 100}%` }}
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
            <li className={`continuity-point is-${state}`} key={point.label}>
              <span className="continuity-knot" aria-hidden="true" />
              <span className="continuity-label">{point.label}</span>
              <time dateTime={new Date(point.date).toISOString()}>
                {formatDate(point.date)}
              </time>
            </li>
          );
        })}
      </ol>
      <p className="continuity-boundary">
        Release logic is not active in this build.
      </p>
    </div>
  );
}
