import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { useThrottledValue } from "@tanstack/react-pacer";

import { useNowSecond } from "../../hooks/useNowSecond";
import { deriveThreadStatistics } from "../../lib/threadStatistics";
import { useThreadHistory, useThreadProjection } from "../../state/entities";
import { ComposerStatsFooter } from "./ComposerStatsFooter";

function LiveStatistics({
  projection,
  partialHistory,
}: {
  readonly projection: ThreadStructure;
  readonly partialHistory: boolean;
}) {
  const nowMs = useNowSecond();
  const statistics = deriveThreadStatistics(projection, partialHistory, nowMs);
  return <ComposerStatsFooter statistics={statistics} activity={statistics.activity} />;
}

export function ThreadStatsFooter({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const current = useThreadProjection(threadRef)?.projection ?? null;
  const history = useThreadHistory(threadRef);
  const [sampled] = useThrottledValue(current, { wait: 250, leading: true, trailing: true });
  const projection = sampled?.thread.id === threadRef.threadId ? sampled : current;
  if (projection === null) return null;
  const partialHistory = history.hasMoreHistory;
  const live = projection.providerTurns.some(
    (turn) => turn.status === "pending" || turn.status === "running",
  );
  return live ? (
    <LiveStatistics projection={projection} partialHistory={partialHistory} />
  ) : (
    <ComposerStatsFooter statistics={deriveThreadStatistics(projection, partialHistory)} />
  );
}
