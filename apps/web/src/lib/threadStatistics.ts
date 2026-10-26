import type { ThreadStructure, ThreadStructureTurnItem } from "@t3tools/client-runtime/state/shell";

export interface ThreadStatistics {
  readonly activity: "generating" | "tools" | "waiting" | "idle";
  readonly turnCount: number;
  readonly stepCount: number | null;
  readonly llmDurationMs: number | null;
  readonly averageTtftMs: number | null;
  readonly outputTokensPerSecond: number | null;
  readonly cacheHitPercent: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly partial: boolean;
  readonly estimatedFields: readonly (
    | "stepCount"
    | "llmDurationMs"
    | "averageTtftMs"
    | "outputTokensPerSecond"
    | "inputTokens"
    | "outputTokens"
  )[];
}

type StatisticsProjection = Pick<
  ThreadStructure,
  "thread" | "runs" | "nodes" | "providerTurns" | "runtimeRequests" | "messages" | "turnItems"
>;
type Interval = readonly [start: number, end: number];
const TOOL_ITEMS = new Set([
  "command_execution",
  "dynamic_tool",
  "file_search",
  "web_search",
  "file_change",
]);
const WAIT_NODES = new Set(["tool_call", "approval_request", "user_input_request"]);
const WAIT_ITEMS = new Set([...TOOL_ITEMS, "approval_request", "user_input_request"]);
const ACTIVE_STATUSES = new Set(["pending", "running", "waiting"]);

function timestamp(value: unknown): number | null {
  // Structured-cloned thread snapshots retain the epoch but lose DateTime's prototype.
  const result =
    typeof value === "string"
      ? Date.parse(value)
      : typeof value === "object" &&
          value !== null &&
          "epochMilliseconds" in value &&
          typeof value.epochMilliseconds === "number"
        ? value.epochMilliseconds
        : Number.NaN;
  return Number.isFinite(result) && result >= 0 && result <= 8.64e15 ? result : null;
}

function tokenCount(value: number | undefined): number | null {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function estimateVisibleTokens(text: unknown): number | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  // A deliberately approximate, tokenizer-free count: four ASCII characters or
  // one non-ASCII code point per token. Iteration preserves surrogate pairs.
  let units = 0;
  for (const character of text) units += character.codePointAt(0)! <= 0x7f ? 1 : 4;
  return Math.ceil(units / 4);
}

function unionDuration(intervals: readonly Interval[], start: number, end: number): number {
  const clipped = intervals
    .map(([from, to]): Interval => [Math.max(start, from), Math.min(end, to)])
    .filter(([from, to]) => to > from)
    .toSorted(([a], [b]) => a - b);
  let duration = 0;
  let previousEnd = start;
  for (const [from, to] of clipped) {
    duration += Math.max(0, to - Math.max(from, previousEnd));
    previousEnd = Math.max(previousEnd, to);
  }
  return duration;
}

function subtractIntervals(
  intervals: readonly Interval[],
  excluded: readonly Interval[],
): Interval[] {
  const sorted = excluded.toSorted(([a], [b]) => a - b);
  return intervals.flatMap(([start, end]) => {
    const pieces: Interval[] = [];
    let cursor = start;
    for (const [from, to] of sorted) {
      if (to <= cursor) continue;
      if (from >= end) break;
      if (from > cursor) pieces.push([cursor, from]);
      cursor = Math.max(cursor, to);
      if (cursor >= end) break;
    }
    if (cursor < end) pieces.push([cursor, end]);
    return pieces;
  });
}

export function deriveThreadStatistics(
  projection: StatisticsProjection,
  partialHistory = false,
  nowMs?: number,
): ThreadStatistics {
  let partial = partialHistory;
  // Without an explicit clock, deriving statistics from persisted state stays pure.
  const now =
    nowMs !== undefined && Number.isFinite(nowMs) && nowMs >= 0 && nowMs <= 8.64e15 ? nowMs : null;
  const nodes = new Map<string, StatisticsProjection["nodes"][number]>(
    projection.nodes.map((node) => [node.id, node]),
  );
  const runs = new Map(projection.runs.map((run) => [run.id, run]));
  const runsByUserMessage = new Map<string, StatisticsProjection["runs"][number]>(
    projection.runs
      .filter(
        (run) =>
          run.threadId === projection.thread.id &&
          run.delegatedTaskId === undefined &&
          run.restartContinuationOfRunId === undefined,
      )
      .map((run) => [run.userMessageId, run]),
  );
  const roots = new Map<string, string | null>();
  function rootForNode(id: string | null): string | null {
    if (id === null) return null;
    const visited = new Set<string>();
    let current: string | null = id;
    let root: string | null = null;
    while (current !== null && !visited.has(current)) {
      if (roots.has(current)) {
        root = roots.get(current) ?? null;
        break;
      }
      visited.add(current);
      const node = nodes.get(current);
      if (!node || node.kind === "subagent" || node.threadId !== projection.thread.id) break;
      if (node.runId !== null && runs.get(node.runId)?.delegatedTaskId !== undefined) break;
      if (node.kind === "root_turn" && node.parentNodeId === null) {
        root = node.id;
        break;
      }
      current = node.parentNodeId;
    }
    for (const key of visited) roots.set(key, root);
    return root;
  }

  const turns = projection.providerTurns.filter((turn) => {
    const node = nodes.get(turn.nodeId);
    if (!node) partial = true;
    return node?.kind === "root_turn" && rootForNode(turn.nodeId) === turn.nodeId;
  });
  const byTurn = new Map(
    turns.map((turn) => [
      turn.id,
      {
        turn,
        items: [] as ThreadStructureTurnItem[],
        nodes: [] as StatisticsProjection["nodes"][number][],
        requests: [] as StatisticsProjection["runtimeRequests"][number][],
        outputMessages: [] as StatisticsProjection["messages"][number][],
        unresolvedWait: false,
      },
    ]),
  );
  const turnsByRoot = new Map<string, typeof turns>();
  for (const turn of turns) {
    const group = turnsByRoot.get(turn.nodeId) ?? [];
    group.push(turn);
    turnsByRoot.set(turn.nodeId, group);
  }
  function assignedTurn(
    nodeId: StatisticsProjection["nodes"][number]["id"] | null,
    providerTurnId: StatisticsProjection["providerTurns"][number]["id"] | null,
  ) {
    const root = rootForNode(nodeId);
    if (nodeId !== null && root === null) return undefined;
    if (providerTurnId !== null) {
      const group = byTurn.get(providerTurnId);
      if (group && root !== null && root !== group.turn.nodeId) {
        partial = true;
        return undefined;
      }
      return group;
    }
    const nodeTurnId = nodeId === null ? null : nodes.get(nodeId)?.providerTurnId;
    const candidates = root === null ? undefined : turnsByRoot.get(root);
    if (nodeTurnId != null && !(nodeId === root && (candidates?.length ?? 0) > 1))
      return byTurn.get(nodeTurnId);
    if (candidates?.length === 1) return byTurn.get(candidates[0]!.id);
    if (root !== null) partial = true;
    return undefined;
  }
  function markUnassignedWait(
    nodeId: StatisticsProjection["nodes"][number]["id"] | null,
    providerTurnId: StatisticsProjection["providerTurns"][number]["id"] | null,
  ) {
    const root = rootForNode(nodeId);
    if (nodeId !== null && nodes.has(nodeId) && root === null) return;
    const candidates =
      providerTurnId !== null
        ? [byTurn.get(providerTurnId)]
        : (root === null ? [] : (turnsByRoot.get(root) ?? [])).map((turn) => byTurn.get(turn.id));
    for (const group of candidates) {
      if (!group) continue;
      group.unresolvedWait = true;
      partial = true;
    }
  }
  const itemsById = new Map(projection.turnItems.map((item) => [item.id, item]));
  function isChildItem(item: ThreadStructureTurnItem): boolean {
    const visited = new Set<string>();
    let parent = item.parentItemId;
    while (parent !== null && !visited.has(parent)) {
      visited.add(parent);
      const ancestor = itemsById.get(parent);
      if (!ancestor) {
        partial = true;
        return true;
      }
      if (ancestor.type === "subagent") return true;
      parent = ancestor.parentItemId;
    }
    if (parent !== null) partial = true;
    return parent !== null;
  }
  for (const item of itemsById.values()) {
    if (item.threadId === projection.thread.id && !isChildItem(item)) {
      const group = assignedTurn(item.nodeId, item.providerTurnId);
      if (group) group.items.push(item);
      else if (WAIT_ITEMS.has(item.type) && item.toolNonExecutionKind === undefined)
        markUnassignedWait(item.nodeId, item.providerTurnId);
    }
  }
  for (const node of projection.nodes) {
    assignedTurn(node.id, node.providerTurnId)?.nodes.push(node);
  }
  for (const request of projection.runtimeRequests) {
    const group = assignedTurn(request.nodeId, request.providerTurnId);
    if (group) group.requests.push(request);
    else markUnassignedWait(request.nodeId, request.providerTurnId);
  }

  const excludedMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.role === "user" &&
          (message.notification !== undefined ||
            message.delegatedCompletion !== undefined ||
            message.senderThreadId !== undefined),
      )
      .map((message) => message.id),
  );
  for (const item of itemsById.values()) {
    if (item.type === "user_message" && isChildItem(item)) excludedMessageIds.add(item.messageId);
  }
  const excludedTurnKeys = new Set([...excludedMessageIds].map((id) => `message:${id}`));
  const turnKeys = new Set<string>();
  const visiblePrompts = new Map<string, { readonly root: string; readonly text: string }>();
  function recordPrompt(
    id: string,
    nodeId: StatisticsProjection["nodes"][number]["id"] | null,
    run: StatisticsProjection["runs"][number] | undefined,
    text: string,
  ) {
    const promptRun = run ?? runsByUserMessage.get(id);
    // A resumed run's synthetic prompt is not additional visible user input.
    if (promptRun?.restartContinuationOfRunId !== undefined) return;
    const root = rootForNode(nodeId ?? promptRun?.rootNodeId ?? null);
    if (root !== null) visiblePrompts.set(id, { root, text });
  }
  function addTurnKey(key: string) {
    if (!excludedTurnKeys.has(key)) turnKeys.add(key);
  }
  function runKey(run: StatisticsProjection["runs"][number]): string {
    const visited = new Set<string>();
    let current = run;
    while (current.restartContinuationOfRunId !== undefined && !visited.has(current.id)) {
      visited.add(current.id);
      const previous = runs.get(current.restartContinuationOfRunId);
      if (!previous) return `run:${current.restartContinuationOfRunId}`;
      current = previous;
    }
    return `message:${current.userMessageId}`;
  }
  for (const run of projection.runs) {
    if (
      run.threadId === projection.thread.id &&
      run.delegatedTaskId === undefined &&
      !excludedMessageIds.has(run.userMessageId) &&
      (run.rootNodeId === null ||
        !nodes.has(run.rootNodeId) ||
        rootForNode(run.rootNodeId) === run.rootNodeId)
    ) {
      addTurnKey(runKey(run));
    }
  }
  for (const message of projection.messages) {
    if (
      message.role !== "user" ||
      message.threadId !== projection.thread.id ||
      excludedMessageIds.has(message.id) ||
      (message.nodeId !== null && rootForNode(message.nodeId) === null)
    )
      continue;
    const run = message.runId === null ? undefined : runs.get(message.runId);
    if (run?.delegatedTaskId !== undefined) continue;
    addTurnKey(
      run?.restartContinuationOfRunId !== undefined ? runKey(run) : `message:${message.id}`,
    );
    if (message.createdBy === "user") recordPrompt(message.id, message.nodeId, run, message.text);
  }
  for (const item of projection.turnItems) {
    if (
      item.type !== "user_message" ||
      item.threadId !== projection.thread.id ||
      item.senderThreadId !== undefined ||
      excludedMessageIds.has(item.messageId) ||
      isChildItem(item) ||
      (item.nodeId !== null && rootForNode(item.nodeId) === null)
    )
      continue;
    const run = item.runId === null ? undefined : runs.get(item.runId);
    if (run?.delegatedTaskId !== undefined) continue;
    addTurnKey(
      run?.restartContinuationOfRunId !== undefined ? runKey(run) : `message:${item.messageId}`,
    );
    if (item.createdBy === "user") recordPrompt(item.messageId, item.nodeId, run, item.text);
  }

  const messages = new Map(projection.messages.map((message) => [message.id, message]));
  // Assistant items and conversation messages mirror the same output. Prefer the
  // item (including its current streamed text); use a message only if no row exists.
  const representedMessages = new Set(
    projection.turnItems.flatMap((item) =>
      item.type === "assistant_message" ? [item.messageId] : [],
    ),
  );
  for (const message of messages.values()) {
    if (
      message.role !== "assistant" ||
      message.threadId !== projection.thread.id ||
      representedMessages.has(message.id)
    )
      continue;
    const run = message.runId === null ? undefined : runs.get(message.runId);
    if (run?.delegatedTaskId !== undefined) continue;
    assignedTurn(message.nodeId ?? run?.rootNodeId ?? null, null)?.outputMessages.push(message);
  }
  const promptsByRoot = new Map<string, Map<string, string>>();
  for (const [id, { root, text }] of visiblePrompts) {
    const prompts = promptsByRoot.get(root) ?? new Map<string, string>();
    prompts.set(id, text);
    promptsByRoot.set(root, prompts);
  }
  const estimatedPromptIds = new Set<string>();
  let inputEstimated = false;
  let outputEstimated = false;
  let steps = 0;
  let modelTime = 0;
  let modelTimeCount = 0;
  let ttftTotal = 0;
  let ttftCount = 0;
  let generationTime = 0;
  let measuredOutput = 0;
  let measuredTurns = 0;
  let activity: ThreadStatistics["activity"] = "idle";
  let inputTotal: number | null = null;
  let outputTotal: number | null = null;
  let cacheInput = 0;
  let cacheRead = 0;
  let cacheCoverage = turns.length > 0;

  for (const {
    turn,
    items,
    nodes: turnNodes,
    requests,
    outputMessages,
    unresolvedWait,
  } of byTurn.values()) {
    const start = timestamp(turn.startedAt);
    const completed = timestamp(turn.completedAt);
    const ordered = items.toSorted((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id));
    const nonExecutionNodes = new Set(
      items.filter((item) => item.toolNonExecutionKind !== undefined).map((item) => item.nodeId),
    );
    const toolStarts = turnNodes
      .filter((node) => node.kind === "tool_call" && !nonExecutionNodes.has(node.id))
      .map((node) => timestamp(node.startedAt))
      .filter((value) => value !== null)
      .toSorted((a, b) => a - b);
    let toolIndex = 0;
    let previousOutputStart: number | null = null;
    let outputGroups = 0;
    let separatedByTool = true;
    let firstOutput: number | null = null;
    // Message-only output has no reliable first-delta timestamp. Its text can
    // be counted, but it must not shorten the denominator used for a token rate.
    let unlocatedOutput = outputMessages.some((message) => message.text.trim().length > 0);
    const outputTexts = new Map<string, unknown>();
    for (const item of ordered) {
      if (TOOL_ITEMS.has(item.type) && item.toolNonExecutionKind === undefined) {
        separatedByTool = true;
      }
      if (item.type !== "reasoning" && item.type !== "assistant_message") continue;
      const text =
        "text" in item
          ? item.text
          : item.type === "assistant_message"
            ? messages.get(item.messageId)?.text
            : undefined;
      outputTexts.set(
        item.type === "assistant_message" ? `message:${item.messageId}` : `reasoning:${item.id}`,
        text,
      );
      const outputStart = timestamp(item.startedAt);
      const outputEnd = timestamp(item.completedAt);
      // Quiet thread structures omit reasoning text. A started running item or a
      // completed interval is only approximate first-output evidence, never exact TTFT.
      const inferredReasoning =
        typeof text !== "string" &&
        item.type === "reasoning" &&
        outputStart !== null &&
        start !== null &&
        outputStart >= start &&
        (completed === null || outputStart <= completed) &&
        ((item.status === "running" && item.streaming && ACTIVE_STATUSES.has(turn.status)) ||
          (item.status === "completed" && outputEnd !== null && outputEnd >= outputStart));
      if (typeof text === "string" ? text.trim().length === 0 : !inferredReasoning) continue;
      if (outputStart !== null) {
        while (toolIndex < toolStarts.length && toolStarts[toolIndex]! <= outputStart) {
          if (previousOutputStart !== null && toolStarts[toolIndex]! > previousOutputStart)
            separatedByTool = true;
          toolIndex += 1;
        }
        previousOutputStart = outputStart;
      }
      if (separatedByTool) outputGroups += 1;
      separatedByTool = false;
      if (outputStart !== null) firstOutput = Math.min(firstOutput ?? outputStart, outputStart);
      else unlocatedOutput = true;
    }
    steps += Math.max(1, outputGroups);
    if (unlocatedOutput) {
      firstOutput = null;
      partial = true;
    }

    // Context snapshots can be cumulative. Only explicitly scoped turn usage is additive.
    const usage = turn.turnTokenUsage;
    const reportedInput = tokenCount(usage?.inputTokens);
    let input = reportedInput;
    let output = tokenCount(usage?.outputTokens);
    let turnOutputEstimated = false;
    if (input === null) {
      // This is a visible-prompt lower bound. Hidden context, previous turns,
      // attachments, and tools cannot be inferred from the recorded prompt.
      for (const [id, text] of promptsByRoot.get(turn.nodeId) ?? []) {
        if (estimatedPromptIds.has(id)) continue;
        const estimate = estimateVisibleTokens(text);
        if (estimate === null) continue;
        input = (input ?? 0) + estimate;
        estimatedPromptIds.add(id);
        inputEstimated = true;
        partial = true;
      }
    }
    if (output === null) {
      for (const message of outputMessages) outputTexts.set(`message:${message.id}`, message.text);
      for (const text of outputTexts.values()) {
        const estimate = estimateVisibleTokens(text);
        if (estimate === null) continue;
        output = (output ?? 0) + estimate;
        turnOutputEstimated = true;
      }
      if (turnOutputEstimated) {
        outputEstimated = true;
        partial = true;
      }
    }
    if (input !== null) inputTotal = (inputTotal ?? 0) + input;
    if (output !== null) outputTotal = (outputTotal ?? 0) + output;
    if (usage?.usageStatus !== "complete" || input === null || output === null) partial = true;
    const cached = tokenCount(usage?.cachedInputTokens);
    if (reportedInput === null || cached === null || cached > reportedInput) {
      cacheCoverage = false;
    } else {
      cacheInput += reportedInput;
      cacheRead += cached;
    }

    let end = completed;
    const running = ACTIVE_STATUSES.has(turn.status);
    if (end === null && running) {
      const observations = [
        ...items.flatMap((item) => [
          timestamp(item.startedAt),
          timestamp(item.completedAt),
          timestamp("updatedAt" in item ? item.updatedAt : undefined),
        ]),
        ...turnNodes.flatMap((node) => [timestamp(node.startedAt), timestamp(node.completedAt)]),
        ...requests.flatMap((request) => [
          timestamp(request.createdAt),
          timestamp(request.resolvedAt),
        ]),
        timestamp(turn.tokenUsage?.updatedAt),
      ].filter((value): value is number => value !== null && (start === null || value >= start));
      end =
        now !== null
          ? Math.max(start ?? now, now)
          : observations.reduce<number | null>(
              (latest, value) => Math.max(latest ?? value, value),
              null,
            );
      partial = true;
    }
    const representedWaitNodes = new Set(
      items.filter((item) => WAIT_ITEMS.has(item.type)).map((item) => item.nodeId),
    );
    const waiting =
      requests.some((request) => request.status === "pending") ||
      items.some(
        (item) =>
          (item.type === "approval_request" || item.type === "user_input_request") &&
          ACTIVE_STATUSES.has(item.status),
      ) ||
      turnNodes.some(
        (node) =>
          (node.kind === "approval_request" || node.kind === "user_input_request") &&
          !representedWaitNodes.has(node.id) &&
          ACTIVE_STATUSES.has(node.status),
      );
    const tooling =
      items.some(
        (item) =>
          TOOL_ITEMS.has(item.type) &&
          item.toolNonExecutionKind === undefined &&
          ACTIVE_STATUSES.has(item.status),
      ) ||
      turnNodes.some(
        (node) =>
          node.kind === "tool_call" &&
          !representedWaitNodes.has(node.id) &&
          !nonExecutionNodes.has(node.id) &&
          ACTIVE_STATUSES.has(node.status),
      );
    const waits: Interval[] = [];
    const toolWaits: Interval[] = [];
    let waitsKnown = !unresolvedWait;
    function addWait(from: number | null, to: number | null, tool = false) {
      if (from === null || to === null || to < from) {
        waitsKnown = false;
      } else {
        (tool ? toolWaits : waits).push([from, to]);
      }
    }
    const representedNodes = new Set<string>();
    const requestsById = new Map(requests.map((request) => [request.id, request]));
    for (const item of items) {
      if (!WAIT_ITEMS.has(item.type)) continue;
      if (item.nodeId !== null) representedNodes.add(item.nodeId);
      if (item.toolNonExecutionKind !== undefined) continue;
      if (
        (item.type === "approval_request" || item.type === "user_input_request") &&
        requestsById.has(item.requestId)
      )
        continue;
      addWait(
        timestamp(item.startedAt),
        timestamp(item.completedAt) ??
          (ACTIVE_STATUSES.has(item.status)
            ? end
            : timestamp("updatedAt" in item ? item.updatedAt : undefined)),
        TOOL_ITEMS.has(item.type),
      );
    }
    for (const node of turnNodes) {
      if (!WAIT_NODES.has(node.kind) || representedNodes.has(node.id)) continue;
      if (node.runtimeRequestId !== null && requestsById.has(node.runtimeRequestId)) continue;
      addWait(
        timestamp(node.startedAt),
        timestamp(node.completedAt) ?? (ACTIVE_STATUSES.has(node.status) ? end : null),
        node.kind === "tool_call",
      );
    }
    for (const request of requests) {
      addWait(
        timestamp(request.createdAt),
        timestamp(request.resolvedAt) ?? (request.status === "pending" ? end : null),
      );
    }
    const latestToolStart = toolWaits.reduce<number | null>(
      (latest, [from]) => (end !== null && from <= end ? Math.max(latest ?? from, from) : latest),
      null,
    );
    const outputIntervals: Interval[] = [];
    let streamingPastTool = false;
    for (const item of items) {
      if (item.type !== "assistant_message" && item.type !== "reasoning") continue;
      const text =
        "text" in item
          ? item.text
          : item.type === "assistant_message"
            ? messages.get(item.messageId)?.text
            : undefined;
      if (typeof text === "string" ? text.trim().length === 0 : item.type !== "reasoning") continue;
      const from = timestamp(item.startedAt);
      if (from === null || end === null || from > end) continue;
      const observed =
        timestamp(item.completedAt) ??
        timestamp("updatedAt" in item ? item.updatedAt : undefined) ??
        from;
      const liveOutput = running && ACTIVE_STATUSES.has(item.status) && item.streaming;
      const fresh =
        latestToolStart === null || from >= latestToolStart || observed > latestToolStart;
      if (liveOutput && fresh) streamingPastTool = true;
      const to = Math.min(end, liveOutput && fresh ? end : observed);
      if (to > from) outputIntervals.push([from, to]);
    }
    // Tool lifetimes can overlap model output (for example, a background shell).
    // Recorded output intervals win over tool time; approval waits still block.
    const blocked = [...waits, ...subtractIntervals(toolWaits, outputIntervals)];
    if (running) {
      const currentActivity = waiting
        ? "waiting"
        : tooling && !streamingPastTool
          ? "tools"
          : "generating";
      if (
        activity === "idle" ||
        currentActivity === "generating" ||
        (activity === "waiting" && currentActivity === "tools")
      )
        activity = currentActivity;
    }
    const duration =
      start !== null && end !== null && end >= start && waitsKnown
        ? end - start - unionDuration(blocked, start, end)
        : null;
    const latency =
      start !== null &&
      end !== null &&
      end >= start &&
      firstOutput !== null &&
      firstOutput >= start &&
      firstOutput <= end
        ? firstOutput - start
        : null;
    if (duration !== null) {
      modelTime += duration;
      modelTimeCount += 1;
    } else {
      partial = true;
    }
    if (latency !== null) {
      ttftTotal += latency;
      ttftCount += 1;
    }
    if (
      (turnOutputEstimated
        ? running && now === null
        : running || usage?.usageStatus !== "complete") ||
      output === null ||
      duration === null ||
      latency === null ||
      start === null ||
      firstOutput === null
    ) {
      partial = true;
    } else {
      // Pre-output tool/wait time is already removed from model time, so remove it
      // from the matching latency too rather than subtracting that time twice.
      const generating = duration - (latency - unionDuration(blocked, start, firstOutput));
      if (generating > 0) {
        measuredOutput += output;
        measuredTurns += 1;
        generationTime += generating;
      } else partial = true;
    }
  }

  const stepCount = turns.length > 0 ? steps : null;
  const llmDurationMs = modelTimeCount > 0 ? modelTime : null;
  const averageTtftMs = ttftCount > 0 ? ttftTotal / ttftCount : null;
  const outputTokensPerSecond =
    measuredTurns > 0 && generationTime > 0 ? (measuredOutput * 1_000) / generationTime : null;
  if (ttftCount > 0 && ttftCount < turns.length) partial = true;
  const estimatedFields: ThreadStatistics["estimatedFields"][number][] = [];
  if (stepCount !== null) estimatedFields.push("stepCount");
  if (llmDurationMs !== null) estimatedFields.push("llmDurationMs");
  if (averageTtftMs !== null) estimatedFields.push("averageTtftMs");
  if (outputTokensPerSecond !== null) estimatedFields.push("outputTokensPerSecond");
  if (inputEstimated) estimatedFields.push("inputTokens");
  if (outputEstimated) estimatedFields.push("outputTokens");
  return {
    activity,
    turnCount: turnKeys.size,
    stepCount,
    llmDurationMs,
    averageTtftMs,
    outputTokensPerSecond,
    cacheHitPercent: cacheCoverage && cacheInput > 0 ? (cacheRead * 100) / cacheInput : null,
    inputTokens: inputTotal,
    outputTokens: outputTotal,
    partial,
    estimatedFields,
  };
}
