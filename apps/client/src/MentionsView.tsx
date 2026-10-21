import { Skeleton } from './Loading';
import { useState } from 'react';
import type { Project, MentionsSummary } from '@citevia/core';
import { useApi } from './api';
import { Empty, ErrorNotice } from './components';
import {
  AnswerTable,
  initialSelection,
  MentionsChart,
  MonitoringHeader,
  PageControls,
  ProviderDonut,
  selectionQuery,
  type AnswerPage,
} from './MonitoringUI';
import { TrackingDetailDrawer } from './TrackingView';

export default function MentionsView({
  path,
  project,
  revision,
  onResponse,
}: {
  path: string;
  project: Project;
  revision: number;
  onResponse: (id: string) => void;
}) {
  const [selection, setSelection] = useState(() => initialSelection()),
    [page, setPage] = useState(0),
    [size, setSize] = useState(25),
    [sort, setSort] = useState('date'),
    [direction, setDirection] = useState('desc'),
    [tracked, setTracked] = useState<string>();
  const params = selectionQuery(selection);
  const summary = useApi<MentionsSummary>(
    `${path}/mentions/summary${params}`,
    revision,
  );
  const answers = useApi<AnswerPage>(
    `${path}/mentions${selectionQuery(selection, { page, pageSize: size, sort, direction })}`,
    revision,
  );
  return (
    <div className="monitor-screen mentions-screen">
      <MonitoringHeader
        title="Mentions"
        project={project}
        value={selection}
        onChange={(s) => {
          setSelection(s);
          setPage(0);
        }}
      />
      <ErrorNotice error={summary.error || answers.error} />
      {summary.loading && !summary.data ? (
        <Skeleton variant="chart" label="Loading mention history…" />
      ) : (
        summary.data && (
          <div className="mentions-charts">
            <ProviderDonut summary={summary.data} />
            <MentionsChart summary={summary.data} onTracked={setTracked} />
          </div>
        )
      )}
      <section
        className="monitor-card mention-answers"
        aria-label="Mentioned answers"
        aria-busy={answers.loading}
      >
        {answers.loading && !answers.data ? (
          <Skeleton variant="table" label="Loading answers…" />
        ) : answers.data?.items.length ? (
          <>
            <AnswerTable
              rows={answers.data.items}
              onResponse={onResponse}
              sort={sort}
              direction={direction}
              onSort={(next) => {
                setDirection(
                  next === sort && direction === 'desc' ? 'asc' : 'desc',
                );
                setSort(next);
                setPage(0);
              }}
            />
            <PageControls
              total={answers.data.total}
              page={page}
              pageSize={size}
              onPage={setPage}
              onSize={(s) => {
                setSize(s);
                setPage(0);
              }}
              loading={answers.loading}
            />
          </>
        ) : (
          !answers.error && (
            <Empty
              title="No mentions in this range"
              description="Try another date range or provider. Answers that mention your brand will appear after a scan."
            />
          )
        )}
      </section>
      {tracked && (
        <TrackingDetailDrawer
          path={path}
          id={tracked}
          selection={selection}
          revision={revision}
          onClose={() => setTracked(undefined)}
          onResponse={(id) => {
            setTracked(undefined);
            onResponse(id);
          }}
        />
      )}
    </div>
  );
}
