import { describe, expect, it } from "vite-plus/test";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  MessageId,
  NodeId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { makeThreadProjectionFixture } from "../test-fixtures";
import { deriveThreadStatistics } from "./threadStatistics";

const at = (milliseconds: number) => DateTime.makeUnsafe(1_700_000_000_000 + milliseconds);
const rootId = NodeId.make("root");
const runId = RunId.make("run");
const providerTurnId = ProviderTurnId.make("turn");
const providerThreadId = ProviderThreadId.make("provider-thread");

function usage(overrides: Partial<TurnTokenUsage> = {}): TurnTokenUsage {
  return {
    usageScope: "main_agent",
    usageStatus: "complete",
    hasSubagents: false,
    inputTokens: 1_000,
    cachedInputTokens: 400,
    cacheCreationTokens: 50,
    outputTokens: 600,
    reasoningTokens: 200,
    ...overrides,
  } as TurnTokenUsage;
}

function run(overrides: Partial<OrchestrationV2Run> = {}): OrchestrationV2Run {
  const { thread } = makeThreadProjectionFixture();
  return {
    id: runId,
    threadId: thread.id,
    ordinal: 1,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    providerThreadId,
    userMessageId: MessageId.make("user-message"),
    rootNodeId: rootId,
    activeAttemptId: RunAttemptId.make("attempt"),
    status: "completed",
    requestedAt: at(0),
    startedAt: at(0),
    completedAt: at(20_000),
    checkpointId: null,
    contextHandoffId: null,
    ...overrides,
  };
}

function node(overrides: Partial<OrchestrationV2ExecutionNode> = {}): OrchestrationV2ExecutionNode {
  return {
    id: rootId,
    threadId: makeThreadProjectionFixture().thread.id,
    runId,
    parentNodeId: null,
    rootNodeId: rootId,
    kind: "root_turn",
    status: "completed",
    countsForRun: true,
    providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: at(0),
    completedAt: at(20_000),
    ...overrides,
  };
}

function turn(overrides: Partial<OrchestrationV2ProviderTurn> = {}): OrchestrationV2ProviderTurn {
  return {
    id: providerTurnId,
    providerThreadId,
    nodeId: rootId,
    runAttemptId: RunAttemptId.make("attempt"),
    nativeTurnRef: null,
    ordinal: 1,
    status: "completed",
    startedAt: at(0),
    completedAt: at(20_000),
    turnTokenUsage: usage(),
    ...overrides,
  };
}

function item(
  type: "reasoning" | "assistant_message" | "command_execution",
  ordinal: number,
  start: number,
  end: number,
  overrides: Partial<OrchestrationV2TurnItem> = {},
): OrchestrationV2TurnItem {
  const base = {
    id: TurnItemId.make(`item-${ordinal}`),
    threadId: makeThreadProjectionFixture().thread.id,
    runId,
    nodeId: rootId,
    providerThreadId,
    providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at(start),
    completedAt: at(end),
    updatedAt: at(end),
  };
  const content =
    type === "command_execution"
      ? { ...base, type, input: "pwd" }
      : type === "reasoning"
        ? { ...base, type, text: "Thinking", streaming: false }
        : {
            ...base,
            type,
            messageId: MessageId.make(`assistant-${ordinal}`),
            text: "Answer",
            streaming: false,
          };
  return { ...content, ...overrides } as OrchestrationV2TurnItem;
}

function fixture() {
  return {
    ...makeThreadProjectionFixture(),
    runs: [run()],
    nodes: [node()],
    providerTurns: [turn()],
    turnItems: [item("assistant_message", 1, 2_000, 20_000)],
  };
}

function quiet(projection = fixture()): ThreadStructure {
  const { updatedAt: _updatedAt, ...structure } = projection;
  const {
    updatedAt: _threadUpdatedAt,
    lastVisitedAt: _lastVisitedAt,
    ...thread
  } = projection.thread;
  return {
    ...structure,
    thread,
    turnItems: projection.turnItems.map((row) => {
      if (row.type !== "assistant_message" && row.type !== "reasoning") return row;
      const { text: _text, updatedAt: _itemUpdatedAt, ...rest } = row;
      return rest;
    }),
  };
}

function assistantMessage(ordinal: number, text: string): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(`assistant-${ordinal}`),
    threadId: makeThreadProjectionFixture().thread.id,
    runId,
    nodeId: rootId,
    role: "assistant",
    createdBy: "agent",
    creationSource: "provider",
    text,
    attachments: [],
    streaming: false,
    createdAt: at(2_000),
    updatedAt: at(20_000),
  };
}

function userMessage(text: string): OrchestrationV2ConversationMessage {
  return {
    ...assistantMessage(0, text),
    id: run().userMessageId,
    role: "user",
    createdBy: "user",
    createdAt: at(0),
  };
}

function userItem(text: string): OrchestrationV2TurnItem {
  const { streaming: _streaming, ...base } = item("assistant_message", 0, 0, 0) as Extract<
    OrchestrationV2TurnItem,
    { type: "assistant_message" }
  >;
  return {
    ...base,
    type: "user_message",
    messageId: run().userMessageId,
    text,
    createdBy: "user",
    creationSource: "provider",
    inputIntent: "turn_start",
    attachments: [],
  };
}

describe("deriveThreadStatistics", () => {
  it("withholds first-output timing when an earlier message has no matching item", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [assistantMessage(1, "abcdefgh")];
    projection.turnItems = [item("assistant_message", 2, 10_000, 20_000, { text: "ijklmnop" })];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      outputTokens: 4,
      averageTtftMs: null,
      outputTokensPerSecond: null,
      partial: true,
    });
  });

  it("excludes text estimates whose unloaded parent could be a subagent", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.turnItems = [
      item("assistant_message", 1, 2_000, 20_000, { text: "abcd" }),
      item("reasoning", 2, 3_000, 19_000, {
        text: "a".repeat(1_000),
        parentItemId: TurnItemId.make("unloaded-parent"),
      }),
    ];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      outputTokens: 1,
      partial: true,
    });
  });

  it("leaves unavailable metrics unknown for an empty thread", () => {
    expect(deriveThreadStatistics(makeThreadProjectionFixture())).toEqual({
      activity: "idle",
      turnCount: 0,
      stepCount: null,
      llmDurationMs: null,
      averageTtftMs: null,
      outputTokensPerSecond: null,
      cacheHitPercent: null,
      inputTokens: null,
      outputTokens: null,
      partial: false,
      estimatedFields: [],
    });
  });

  it("subtracts overlapping tools and waits once and groups model output around tools", () => {
    const projection = fixture();
    const requestId = RuntimeRequestId.make("approval");
    projection.turnItems = [
      item("reasoning", 1, 2_000, 3_000),
      item("assistant_message", 2, 3_000, 5_000),
      item("command_execution", 3, 5_000, 10_000),
      item("command_execution", 4, 8_000, 12_000),
      item("assistant_message", 5, 14_000, 20_000),
    ];
    projection.runtimeRequests = [
      {
        id: requestId,
        nodeId: rootId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "resolved",
        responseCapability: { type: "message" },
        createdAt: at(11_000),
        resolvedAt: at(13_000),
      },
    ];

    expect(deriveThreadStatistics(projection)).toEqual({
      activity: "idle",
      turnCount: 1,
      stepCount: 2,
      llmDurationMs: 12_000,
      averageTtftMs: 2_000,
      outputTokensPerSecond: 60,
      cacheHitPercent: 40,
      inputTokens: 1_000,
      outputTokens: 600,
      partial: false,
      estimatedFields: ["stepCount", "llmDurationMs", "averageTtftMs", "outputTokensPerSecond"],
    });
  });

  it("uses per-turn counters without adding cache writes, reasoning, or context snapshots again", () => {
    const projection = fixture();
    projection.providerTurns = [
      turn({
        tokenUsage: {
          usedTokens: 900_000,
          inputTokens: 800_000,
          outputTokens: 100_000,
          updatedAt: "2026-10-26T00:00:00Z",
        },
      }),
    ];

    expect(deriveThreadStatistics(projection)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 600,
      cacheHitPercent: 40,
    });
  });

  it("does not sum context counters when scoped usage is absent", () => {
    const projection = fixture();
    projection.providerTurns = [
      turn({
        turnTokenUsage: undefined,
        tokenUsage: {
          usedTokens: 50_000,
          inputTokens: 40_000,
          outputTokens: 10_000,
          updatedAt: "2026-10-26T00:00:00Z",
        },
      }),
    ];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      inputTokens: null,
      outputTokens: 2,
      cacheHitPercent: null,
      partial: true,
    });
    expect(deriveThreadStatistics(projection).outputTokensPerSecond).toBeCloseTo(2 / 18);
  });

  it("keeps reported input while estimating missing output with matching timing", () => {
    const projection = fixture();
    projection.providerTurns = [
      turn({ turnTokenUsage: usage({ usageStatus: "partial", outputTokens: undefined }) }),
    ];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 2,
      partial: true,
    });
    expect(deriveThreadStatistics(projection).outputTokensPerSecond).toBeCloseTo(2 / 18);
  });

  it("estimates available prompt, assistant, and reasoning text without counting message mirrors", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [userMessage("abcdefgh"), assistantMessage(2, "ijklmnop")];
    projection.turnItems = [
      userItem("abcdefgh"),
      item("reasoning", 1, 2_000, 5_000, { text: "abcd" }),
      item("assistant_message", 2, 5_000, 20_000, { text: "ijklmnop" }),
    ];
    const stats = deriveThreadStatistics(projection);
    expect(stats).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
      cacheHitPercent: null,
      partial: true,
    });
    expect(stats.outputTokensPerSecond).toBeCloseTo(3 / 18);
    expect(stats.estimatedFields).toEqual(
      expect.arrayContaining(["inputTokens", "outputTokens", "outputTokensPerSecond"]),
    );
  });

  it.each(["partial", "unavailable", "complete"] as const)(
    "keeps reported zero authoritative even with %s usage and visible content",
    (usageStatus) => {
      const projection = fixture();
      projection.messages = [userMessage("abcdefgh")];
      projection.providerTurns = [
        turn({
          turnTokenUsage: usage({
            usageStatus,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
          }),
        }),
      ];
      const stats = deriveThreadStatistics(projection);
      expect(stats).toMatchObject({ inputTokens: 0, outputTokens: 0, cacheHitPercent: null });
      expect(stats.estimatedFields).not.toContain("inputTokens");
      expect(stats.estimatedFields).not.toContain("outputTokens");
      expect(stats.outputTokensPerSecond).toBe(usageStatus === "complete" ? 0 : null);
    },
  );

  it("estimates only missing fields and never computes cache hits from estimated input", () => {
    const projection = fixture();
    projection.messages = [userMessage("abcdefgh")];
    projection.providerTurns = [
      turn({
        turnTokenUsage: usage({
          usageStatus: "partial",
          inputTokens: undefined,
          cachedInputTokens: 1,
        }),
      }),
    ];
    const stats = deriveThreadStatistics(projection);
    expect(stats).toMatchObject({
      inputTokens: 2,
      outputTokens: 600,
      cacheHitPercent: null,
      partial: true,
    });
    expect(stats.estimatedFields).toContain("inputTokens");
    expect(stats.estimatedFields).not.toContain("outputTokens");
  });

  it("finds the recorded prompt through a run's userMessageId when its message is unlinked", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [{ ...userMessage("abcdefgh"), nodeId: null, runId: null }];
    expect(deriveThreadStatistics(projection).inputTokens).toBe(2);
    projection.messages = [];
    projection.turnItems.push({ ...userItem("abcdefgh"), nodeId: null, runId: null });
    expect(deriveThreadStatistics(projection).inputTokens).toBe(2);
  });

  it("does not include a child item's user-message mirror in visible prompt estimates", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    const {
      text: _text,
      streaming: _streaming,
      ...base
    } = item("reasoning", 2, 0, 0) as Extract<OrchestrationV2TurnItem, { type: "reasoning" }>;
    const parent: OrchestrationV2TurnItem = {
      ...base,
      type: "subagent",
      subagentId: NodeId.make("child"),
      origin: "provider_native",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: projection.thread.providerInstanceId,
      childThreadId: null,
      prompt: "Work",
      result: null,
    };
    projection.turnItems.push(parent, { ...userItem("abcdefgh"), parentItemId: parent.id });
    projection.messages = [userMessage("abcdefgh")];
    expect(deriveThreadStatistics(projection).inputTokens).toBeNull();
  });

  it("does not estimate missing root history from unrelated visible content", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [userMessage("abcdefgh"), assistantMessage(1, "ijklmnop")];
    projection.nodes = [];
    expect(deriveThreadStatistics(projection, true)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      outputTokensPerSecond: null,
      partial: true,
    });
  });

  it("deduplicates repeated reasoning and assistant rows by item and message identity", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [assistantMessage(2, "abcdefgh")];
    const reasoning = item("reasoning", 1, 2_000, 5_000, { text: "abcd" });
    const assistant = item("assistant_message", 2, 5_000, 20_000, { text: "abcdefgh" });
    projection.turnItems = [
      reasoning,
      reasoning,
      assistant,
      { ...assistant, id: TurnItemId.make("mirror") },
    ];
    expect(deriveThreadStatistics(projection).outputTokens).toBe(3);
  });

  it("combines native counters and visible estimates only for the turns they describe", () => {
    const projection = fixture();
    const retry = ProviderTurnId.make("retry");
    projection.messages = [userMessage("abcdefgh")];
    projection.providerTurns = [
      turn({ turnTokenUsage: usage({ inputTokens: 0, cachedInputTokens: 0 }) }),
      turn({
        id: retry,
        ordinal: 2,
        startedAt: at(21_000),
        completedAt: at(23_000),
        turnTokenUsage: undefined,
      }),
    ];
    projection.turnItems.push(
      item("reasoning", 2, 21_500, 23_000, { text: "abcd", providerTurnId: retry }),
    );
    const stats = deriveThreadStatistics(projection);
    expect(stats).toMatchObject({
      inputTokens: 2,
      outputTokens: 601,
      cacheHitPercent: null,
      partial: true,
    });
    expect(stats.outputTokensPerSecond).toBeCloseTo(601 / 19.5);
  });

  it("counts non-ASCII code points without splitting surrogate pairs", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [userMessage("漢字かな")];
    projection.turnItems = [item("assistant_message", 1, 2_000, 20_000, { text: "\u{1D11E}漢ab" })];
    expect(deriveThreadStatistics(projection)).toMatchObject({ inputTokens: 4, outputTokens: 3 });
  });

  it("does not turn stripped or blank content into zero token estimates", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.turnItems = [item("reasoning", 1, 2_000, 20_000)];
    expect(deriveThreadStatistics(quiet(projection), true)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      outputTokensPerSecond: null,
      partial: true,
    });
    projection.messages = [userMessage("  ")];
    projection.turnItems = [item("assistant_message", 1, 2_000, 20_000, { text: "  " })];
    const stats = deriveThreadStatistics(projection);
    expect(stats).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      outputTokensPerSecond: null,
    });
    expect(stats.estimatedFields).not.toContain("inputTokens");
    expect(stats.estimatedFields).not.toContain("outputTokens");
  });

  it("estimates persisted assistant messages once when their streamed item is outside history", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [assistantMessage(1, "abcdefgh")];
    projection.turnItems = [];
    expect(deriveThreadStatistics(projection, true)).toMatchObject({
      outputTokens: 2,
      averageTtftMs: null,
      outputTokensPerSecond: null,
      partial: true,
    });
  });

  it("uses current streamed text instead of adding an older persisted assistant mirror", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [assistantMessage(1, "abcd")];
    projection.turnItems = [item("assistant_message", 1, 2_000, 20_000, { text: "abcdefgh" })];
    expect(deriveThreadStatistics(projection).outputTokens).toBe(2);
    projection.turnItems = [item("assistant_message", 1, 2_000, 20_000, { text: "" })];
    expect(deriveThreadStatistics(projection).outputTokens).toBeNull();
  });

  it("advances an active model clock from an explicit now and freezes it during tool waits", () => {
    const projection = fixture();
    projection.nodes = [node({ status: "running", completedAt: null })];
    projection.providerTurns = [
      turn({ status: "running", completedAt: null, turnTokenUsage: undefined }),
    ];
    projection.turnItems = [
      item("assistant_message", 1, 2_000, 8_000, {
        text: "abcdefgh",
        status: "running",
        completedAt: null,
        streaming: true,
      }),
    ];
    const now = DateTime.toEpochMillis(at(12_000));
    const stats = deriveThreadStatistics(projection, false, now);
    expect(stats).toMatchObject({ llmDurationMs: 12_000, outputTokens: 2, partial: true });
    expect(stats.outputTokensPerSecond).toBeCloseTo(2 / 10);
    expect(deriveThreadStatistics(projection, false, now + 1_000).llmDurationMs).toBe(13_000);
    projection.turnItems.push(
      item("command_execution", 2, 10_000, 10_000, { status: "running", completedAt: null }),
    );
    expect(deriveThreadStatistics(projection, false, now).llmDurationMs).toBe(10_000);
    expect(deriveThreadStatistics(projection, false, now + 1_000).llmDurationMs).toBe(10_000);
  });

  it("keeps the measured rate when a new turn has not produced output yet", () => {
    const projection = fixture();
    const next = ProviderTurnId.make("next");
    projection.providerTurns.push(
      turn({
        id: next,
        ordinal: 2,
        status: "running",
        startedAt: at(21_000),
        completedAt: null,
        turnTokenUsage: undefined,
      }),
    );
    const stats = deriveThreadStatistics(projection, false, DateTime.toEpochMillis(at(30_000)));
    expect(stats.outputTokensPerSecond).toBeCloseTo(600 / 18);
    expect(stats.partial).toBe(true);
  });

  it("keeps the token rate steady while a tool runs and resumes it with model output", () => {
    const projection = fixture();
    projection.nodes = [node({ status: "running", completedAt: null })];
    projection.providerTurns = [
      turn({ status: "running", completedAt: null, turnTokenUsage: undefined }),
    ];
    projection.turnItems = [
      item("assistant_message", 1, 2_000, 10_000, { text: "abcd".repeat(80) }),
      item("command_execution", 2, 10_000, 10_000, { status: "running", completedAt: null }),
    ];
    const during = deriveThreadStatistics(projection, false, DateTime.toEpochMillis(at(15_000)));
    const later = deriveThreadStatistics(projection, false, DateTime.toEpochMillis(at(25_000)));
    expect(during.outputTokensPerSecond).toBe(10);
    expect(during.activity).toBe("tools");
    expect(later.outputTokensPerSecond).toBe(10);
    projection.turnItems[1] = item("command_execution", 2, 10_000, 30_000);
    projection.turnItems.push(
      item("assistant_message", 3, 30_000, 35_000, {
        text: "abcd".repeat(50),
        status: "running",
        completedAt: null,
        streaming: true,
      }),
    );
    const resumed = deriveThreadStatistics(projection, false, DateTime.toEpochMillis(at(35_000)));
    expect(resumed.outputTokensPerSecond).toBe(10);
    expect(resumed.activity).toBe("generating");
  });

  it("distinguishes approval waits from tool activity and ignores non-executing tool rows", () => {
    const projection = fixture();
    projection.nodes = [node({ status: "running", completedAt: null })];
    projection.providerTurns = [
      turn({ status: "running", completedAt: null, turnTokenUsage: undefined }),
    ];
    projection.turnItems.push(
      item("command_execution", 2, 10_000, 10_000, {
        status: "running",
        completedAt: null,
        toolNonExecutionKind: "plan",
      }),
    );
    expect(deriveThreadStatistics(projection).activity).toBe("generating");
    projection.runtimeRequests = [
      {
        id: RuntimeRequestId.make("approval"),
        nodeId: rootId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: at(10_000),
        resolvedAt: null,
      },
    ];
    expect(deriveThreadStatistics(projection).activity).toBe("waiting");
    projection.providerTurns = [turn()];
    expect(deriveThreadStatistics(projection).activity).toBe("idle");
  });

  it("does not use token counts with missing timing to inflate the measured average", () => {
    const projection = fixture();
    const untimed = ProviderTurnId.make("untimed");
    projection.providerTurns.push(
      turn({
        id: untimed,
        ordinal: 2,
        startedAt: at(21_000),
        completedAt: at(30_000),
        turnTokenUsage: usage({ outputTokens: 10_000 }),
      }),
    );
    const stats = deriveThreadStatistics(projection);
    expect(stats.outputTokens).toBe(10_600);
    expect(stats.outputTokensPerSecond).toBeCloseTo(600 / 18);
    expect(stats.partial).toBe(true);
  });

  it("continues measuring model output while a background tool is still running", () => {
    const projection = fixture();
    projection.nodes = [node({ status: "running", completedAt: null })];
    projection.providerTurns = [
      turn({ status: "running", completedAt: null, turnTokenUsage: undefined }),
    ];
    projection.turnItems = [
      item("assistant_message", 1, 2_000, 10_000, { text: "abcd".repeat(80) }),
      item("command_execution", 2, 10_000, 10_000, { status: "running", completedAt: null }),
      item("assistant_message", 3, 12_000, 20_000, {
        text: "abcd".repeat(80),
        status: "running",
        completedAt: null,
        streaming: true,
      }),
    ];
    const during = deriveThreadStatistics(projection, false, DateTime.toEpochMillis(at(20_000)));
    expect(during.activity).toBe("generating");
    expect(during.llmDurationMs).toBe(18_000);
    expect(during.outputTokensPerSecond).toBe(10);
    projection.turnItems[1] = item("command_execution", 2, 10_000, 25_000);
    projection.turnItems[2] = item("assistant_message", 3, 12_000, 30_000, {
      text: "abcd".repeat(180),
      status: "running",
      completedAt: null,
      streaming: true,
    });
    const after = deriveThreadStatistics(projection, false, DateTime.toEpochMillis(at(30_000)));
    expect(after.activity).toBe("generating");
    expect(after.outputTokensPerSecond).toBe(10);
  });

  it("preserves completed timing when now is supplied", () => {
    const projection = fixture();
    const expected = deriveThreadStatistics(projection);
    expect(deriveThreadStatistics(projection, false, DateTime.toEpochMillis(at(60_000)))).toEqual(
      expected,
    );
    expect(deriveThreadStatistics(projection, false, DateTime.toEpochMillis(at(1_000)))).toEqual(
      expected,
    );
  });

  it("ignores invalid clocks and prevents future observations or starts from creating negative durations", () => {
    const projection = fixture();
    projection.nodes = [node({ status: "running", completedAt: null })];
    projection.providerTurns = [
      turn({ status: "running", completedAt: null, turnTokenUsage: undefined }),
    ];
    projection.turnItems = [
      item("assistant_message", 1, 2_000, 80_000, { status: "running", completedAt: null }),
    ];
    for (const now of [NaN, Infinity, -1, Number.MAX_VALUE]) {
      expect(deriveThreadStatistics(projection, false, now)).toEqual(
        deriveThreadStatistics(projection),
      );
    }
    const now = DateTime.toEpochMillis(at(10_000));
    expect(deriveThreadStatistics(projection, false, now).llmDurationMs).toBe(10_000);
    projection.providerTurns = [
      turn({
        status: "running",
        startedAt: at(12_000),
        completedAt: null,
        turnTokenUsage: undefined,
      }),
    ];
    expect(deriveThreadStatistics(projection, false, now)).toMatchObject({
      llmDurationMs: 0,
      outputTokensPerSecond: null,
    });
  });

  it("does not duplicate visible prompts across retries or include subagent content in estimates", () => {
    const projection = fixture();
    const child = NodeId.make("child");
    const retry = ProviderTurnId.make("retry");
    projection.providerTurns = [
      turn({ turnTokenUsage: undefined }),
      turn({
        id: retry,
        ordinal: 2,
        startedAt: at(21_000),
        completedAt: at(23_000),
        turnTokenUsage: undefined,
      }),
    ];
    projection.nodes.push(node({ id: child, parentNodeId: rootId, kind: "subagent" }));
    projection.messages = [
      userMessage("abcdefgh"),
      { ...assistantMessage(3, "x".repeat(1_000)), nodeId: child },
    ];
    projection.turnItems = [
      userItem("abcdefgh"),
      item("assistant_message", 1, 2_000, 20_000, { text: "abcd" }),
      item("reasoning", 2, 21_500, 23_000, { text: "efgh", providerTurnId: retry }),
      item("assistant_message", 3, 500, 1_000, { text: "x".repeat(1_000), nodeId: child }),
    ];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      turnCount: 1,
      inputTokens: 2,
      outputTokens: 2,
      partial: true,
    });
  });

  it("ignores synthetic restart prompt text even if it is recorded as a user message", () => {
    const projection = fixture();
    const resumedId = RunId.make("resumed");
    projection.runs.push(
      run({
        id: resumedId,
        restartContinuationOfRunId: runId,
        userMessageId: MessageId.make("synthetic"),
      }),
    );
    projection.providerTurns = [turn({ turnTokenUsage: undefined })];
    projection.messages = [
      userMessage("abcd"),
      { ...userMessage("x".repeat(1_000)), id: MessageId.make("synthetic"), runId: resumedId },
    ];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      turnCount: 1,
      inputTokens: 1,
      partial: true,
    });
  });

  it("does not present missing cache reporting as a zero percent cache hit", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ turnTokenUsage: usage({ cachedInputTokens: undefined }) })];
    expect(deriveThreadStatistics(projection).cacheHitPercent).toBeNull();
  });

  it("excludes subagent turns, tool intervals, content, and token counters", () => {
    const projection = fixture();
    const child = NodeId.make("child");
    const nested = NodeId.make("nested-root");
    projection.nodes.push(node({ id: child, kind: "subagent", parentNodeId: rootId }));
    projection.nodes.push(node({ id: nested, rootNodeId: nested, parentNodeId: child }));
    projection.providerTurns.push(turn({ id: ProviderTurnId.make("child-turn"), nodeId: nested }));
    projection.turnItems.push(item("command_execution", 2, 3_000, 19_000, { nodeId: child }));
    projection.turnItems.push(item("reasoning", 3, 500, 1_000, { nodeId: nested }));

    expect(deriveThreadStatistics(projection)).toMatchObject({
      turnCount: 1,
      stepCount: 1,
      llmDurationMs: 20_000,
      averageTtftMs: 2_000,
      inputTokens: 1_000,
      outputTokens: 600,
    });
  });

  it("deduplicates retries and restart continuations while retaining their actual model work", () => {
    const projection = fixture();
    projection.runs.push(
      run({
        id: RunId.make("resumed"),
        userMessageId: MessageId.make("synthetic-resume"),
        restartContinuationOfRunId: runId,
      }),
    );
    projection.providerTurns.push(
      turn({
        id: ProviderTurnId.make("retry-turn"),
        runAttemptId: RunAttemptId.make("retry-attempt"),
        ordinal: 2,
        status: "cancelled",
        startedAt: at(21_000),
        completedAt: at(23_000),
      }),
    );
    projection.turnItems.push(
      item("reasoning", 2, 21_500, 23_000, { providerTurnId: ProviderTurnId.make("retry-turn") }),
    );
    expect(deriveThreadStatistics(projection)).toMatchObject({
      turnCount: 1,
      stepCount: 2,
      llmDurationMs: 22_000,
      averageTtftMs: 1_250,
      inputTokens: 2_000,
      outputTokens: 1_200,
    });
  });

  it("weights cache hits by input tokens across provider switches", () => {
    const projection = fixture();
    projection.runs.push(
      run({
        id: RunId.make("second-run"),
        userMessageId: MessageId.make("second-user"),
        rootNodeId: NodeId.make("second-root"),
      }),
    );
    projection.nodes.push(
      node({
        id: NodeId.make("second-root"),
        rootNodeId: NodeId.make("second-root"),
        runId: RunId.make("second-run"),
      }),
    );
    projection.providerTurns.push(
      turn({
        id: ProviderTurnId.make("second-turn"),
        nodeId: NodeId.make("second-root"),
        providerThreadId: ProviderThreadId.make("different-provider"),
        turnTokenUsage: usage({ inputTokens: 3_000, cachedInputTokens: 1_800, outputTokens: 400 }),
      }),
    );
    projection.turnItems.push(
      item("assistant_message", 2, 4_000, 20_000, {
        providerTurnId: ProviderTurnId.make("second-turn"),
        nodeId: NodeId.make("second-root"),
      }),
    );
    const stats = deriveThreadStatistics(projection);
    expect(stats).toMatchObject({
      turnCount: 2,
      inputTokens: 4_000,
      outputTokens: 1_000,
      cacheHitPercent: 55,
      averageTtftMs: 3_000,
    });
    expect(stats.outputTokensPerSecond).toBeCloseTo(1_000 / 34);
  });

  it("uses reasoning before assistant text for latency and ignores empty placeholders", () => {
    const projection = fixture();
    projection.turnItems = [
      item("assistant_message", 1, 100, 200, { text: " " }),
      item("reasoning", 2, 1_000, 5_000),
      item("assistant_message", 3, 5_000, 20_000),
    ];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      stepCount: 1,
      averageTtftMs: 1_000,
    });
  });

  it("falls back to provider turns for steps without inventing first-token timing", () => {
    const projection = fixture();
    projection.turnItems = [item("command_execution", 1, 2_000, 5_000)];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      stepCount: 1,
      llmDurationMs: 17_000,
      averageTtftMs: null,
      outputTokensPerSecond: null,
    });
  });

  it("uses the last persisted observation for running turns and remains deterministic", () => {
    const projection = fixture();
    projection.nodes = [node({ status: "running", completedAt: null })];
    projection.providerTurns = [
      turn({ status: "running", completedAt: null, turnTokenUsage: undefined }),
    ];
    projection.turnItems = [
      item("assistant_message", 1, 2_000, 8_000, {
        status: "running",
        completedAt: null,
        streaming: true,
      }),
    ];
    const stats = deriveThreadStatistics(projection);
    expect(stats).toMatchObject({
      llmDurationMs: 8_000,
      averageTtftMs: 2_000,
      outputTokensPerSecond: null,
      partial: true,
    });
    expect(deriveThreadStatistics(structuredClone(projection))).toEqual(stats);
  });

  it("clips waits to the provider turn and does not subtract pre-output waits twice", () => {
    const projection = fixture();
    projection.turnItems = [
      item("command_execution", 1, -1_000, 1_000),
      item("assistant_message", 2, 2_000, 20_000),
      item("command_execution", 3, 18_000, 25_000),
    ];
    const stats = deriveThreadStatistics(projection);
    expect(stats).toMatchObject({ llmDurationMs: 19_000, averageTtftMs: 2_000 });
    expect(stats.outputTokensPerSecond).toBeCloseTo(600 / 18);
  });

  it("does not silently include a known tool with unusable timing in model time", () => {
    const projection = fixture();
    projection.turnItems.push(item("command_execution", 2, 10_000, 5_000));
    expect(deriveThreadStatistics(projection)).toMatchObject({
      llmDurationMs: null,
      outputTokensPerSecond: null,
      partial: true,
    });
  });

  it("rejects malformed, negative, and backwards timing instead of returning negative rates", () => {
    const projection = fixture();
    projection.providerTurns = [turn({ startedAt: DateTime.makeUnsafe(-1) })];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      llmDurationMs: null,
      averageTtftMs: null,
      outputTokensPerSecond: null,
      partial: true,
    });
    projection.providerTurns = [turn({ startedAt: "invalid" as never })];
    expect(deriveThreadStatistics(projection).llmDurationMs).toBeNull();
    projection.providerTurns = [turn({ startedAt: at(30_000) })];
    expect(deriveThreadStatistics(projection).llmDurationMs).toBeNull();
  });

  it("marks explicitly paged history partial while retaining available scoped totals", () => {
    expect(deriveThreadStatistics(fixture(), true)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 600,
      partial: true,
    });
  });

  it("preserves reported zero counters but refuses a zero-duration throughput denominator", () => {
    const projection = fixture();
    projection.providerTurns = [
      turn({
        completedAt: at(2_000),
        turnTokenUsage: usage({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
      }),
    ];
    projection.turnItems = [item("assistant_message", 1, 2_000, 2_000)];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheHitPercent: null,
      outputTokensPerSecond: null,
    });
  });

  it("uses tool nodes to separate output groups when the tool item is outside loaded history", () => {
    const projection = fixture();
    projection.nodes.push(
      node({
        id: NodeId.make("tool"),
        parentNodeId: rootId,
        kind: "tool_call",
        startedAt: at(5_000),
        completedAt: at(10_000),
      }),
    );
    projection.turnItems = [
      item("reasoning", 1, 2_000, 4_000),
      item("assistant_message", 2, 12_000, 20_000),
    ];
    expect(deriveThreadStatistics(projection, true)).toMatchObject({
      stepCount: 2,
      llmDurationMs: 15_000,
      partial: true,
    });
  });

  it("uses valid reasoning intervals as marked timing evidence in the actual quiet structure", () => {
    const projection = fixture();
    projection.turnItems = [
      item("reasoning", 1, 500, 1_000),
      item("assistant_message", 2, 5_000, 20_000),
    ];
    projection.messages = [assistantMessage(2, "Answer")];
    const stats = deriveThreadStatistics(quiet(projection));
    expect(stats).toMatchObject({ averageTtftMs: 500, llmDurationMs: 20_000, partial: false });
    expect(stats.outputTokensPerSecond).toBeCloseTo(600 / 19.5);
    expect(stats.estimatedFields).toContain("averageTtftMs");
    expect(stats.estimatedFields).toContain("outputTokensPerSecond");
  });

  it("uses persisted assistant text when both text and updatedAt were stripped from its row", () => {
    const projection = fixture();
    projection.messages = [assistantMessage(1, "Answer")];
    const stats = deriveThreadStatistics(quiet(projection));
    expect(stats).toMatchObject({ averageTtftMs: 2_000, llmDurationMs: 20_000 });
    expect(stats.outputTokensPerSecond).toBeCloseTo(600 / 18);
  });

  it("ignores pending quiet placeholders and assistant rows with no persisted content", () => {
    const projection = fixture();
    projection.turnItems = [
      item("reasoning", 1, 100, 200, { status: "pending", completedAt: null }),
      item("assistant_message", 2, 200, 300),
      item("assistant_message", 3, 2_000, 20_000),
    ];
    projection.messages = [assistantMessage(3, "Answer")];
    expect(deriveThreadStatistics(quiet(projection)).averageTtftMs).toBe(2_000);
  });

  it("anchors an active quiet window to the persisted provider usage update", () => {
    const projection = fixture();
    projection.nodes = [node({ status: "running", completedAt: null })];
    projection.providerTurns = [
      turn({
        status: "running",
        completedAt: null,
        turnTokenUsage: undefined,
        tokenUsage: { usedTokens: 1_000, updatedAt: DateTime.formatIso(at(8_000)) },
      }),
    ];
    projection.turnItems = [
      item("reasoning", 1, 2_000, 4_000, { status: "running", streaming: true, completedAt: null }),
      item("assistant_message", 2, 5_000, 8_000, {
        status: "running",
        streaming: true,
        completedAt: null,
      }),
    ];
    expect(deriveThreadStatistics(quiet(projection))).toMatchObject({
      llmDurationMs: 8_000,
      averageTtftMs: 2_000,
      outputTokensPerSecond: null,
      partial: true,
    });
  });

  it("does not claim later content was first when an earlier output has a malformed timestamp", () => {
    const projection = fixture();
    projection.turnItems = [
      item("reasoning", 1, 500, 1_000, { startedAt: "invalid" as never }),
      item("assistant_message", 2, 5_000, 20_000),
    ];
    expect(deriveThreadStatistics(projection)).toMatchObject({
      averageTtftMs: null,
      outputTokensPerSecond: null,
      partial: true,
    });
  });

  it("keeps terminal user waits authoritative when a display item completes earlier", () => {
    const projection = fixture();
    const requestId = RuntimeRequestId.make("input-request");
    const { input: _input, ...base } = item("command_execution", 2, 5_000, 6_000) as Extract<
      OrchestrationV2TurnItem,
      { type: "command_execution" }
    >;
    projection.turnItems.push({ ...base, type: "user_input_request", requestId, questions: [] });
    projection.runtimeRequests = [
      {
        id: requestId,
        nodeId: rootId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "resolved",
        responseCapability: { type: "message" },
        createdAt: at(5_000),
        resolvedAt: at(12_000),
      },
    ];
    expect(deriveThreadStatistics(projection).llmDurationMs).toBe(13_000);
  });

  it("withholds model time when a known tool's ownership node was not loaded", () => {
    const projection = fixture();
    projection.turnItems.push(
      item("command_execution", 2, 5_000, 10_000, { nodeId: NodeId.make("missing-tool-node") }),
    );
    expect(deriveThreadStatistics(projection)).toMatchObject({
      llmDurationMs: null,
      outputTokensPerSecond: null,
      partial: true,
    });
  });

  it("withholds model time when a root tool cannot be assigned across retry turns", () => {
    const projection = fixture();
    projection.providerTurns.push(
      turn({
        id: ProviderTurnId.make("retry"),
        startedAt: at(21_000),
        completedAt: at(23_000),
        ordinal: 2,
      }),
    );
    projection.turnItems.push(
      item("command_execution", 2, 5_000, 10_000, { providerTurnId: null }),
    );
    expect(deriveThreadStatistics(projection)).toMatchObject({
      llmDurationMs: null,
      outputTokensPerSecond: null,
      partial: true,
    });
  });

  it("counts real user messages once and excludes synthetic continuation messages", () => {
    const projection = fixture();
    const resumedId = RunId.make("resumed");
    projection.runs.push(
      run({
        id: resumedId,
        userMessageId: MessageId.make("synthetic"),
        restartContinuationOfRunId: runId,
      }),
    );
    projection.messages = [
      {
        ...assistantMessage(1, "Prompt"),
        id: run().userMessageId,
        role: "user",
        createdBy: "user",
      },
      {
        ...assistantMessage(2, "Resume"),
        id: MessageId.make("synthetic"),
        role: "user",
        runId: resumedId,
        createdBy: "system",
      },
      {
        ...assistantMessage(3, "Next prompt"),
        id: MessageId.make("next-user"),
        role: "user",
        runId: null,
        nodeId: null,
        createdBy: "user",
      },
    ];
    expect(deriveThreadStatistics(projection).turnCount).toBe(2);
  });

  it.each([
    [
      "notification",
      {
        notification: {
          source: { kind: "subagent" },
          outcome: "completed",
          summary: "Background work completed",
        },
      },
    ],
    [
      "delegated completion",
      {
        delegatedCompletion: { parentRunId: RunId.make("parent-run"), generation: 1, taskIds: [] },
      },
    ],
    ["sender thread", { senderThreadId: ThreadId.make("sender-thread") }],
  ] satisfies ReadonlyArray<readonly [string, Partial<OrchestrationV2ConversationMessage>]>)(
    "excludes root-run-linked %s wakes from turns while retaining their model work",
    (_kind, metadata) => {
      const projection = fixture();
      const wakeMessageId = run().userMessageId;
      projection.messages = [
        {
          ...assistantMessage(1, "Automatic wake"),
          id: wakeMessageId,
          role: "user",
          createdBy: "system",
          ...metadata,
        },
      ];
      const expected = {
        turnCount: 0,
        stepCount: 1,
        llmDurationMs: 20_000,
        averageTtftMs: 2_000,
        inputTokens: 1_000,
        outputTokens: 600,
      };
      expect(deriveThreadStatistics(projection)).toMatchObject(expected);

      const { streaming: _streaming, ...base } = item("assistant_message", 2, 0, 0) as Extract<
        OrchestrationV2TurnItem,
        { type: "assistant_message" }
      >;
      projection.turnItems.push({
        ...base,
        type: "user_message",
        messageId: wakeMessageId,
        inputIntent: "turn_start",
        createdBy: "system",
        creationSource: "server",
        attachments: [],
      });
      expect(deriveThreadStatistics(projection)).toMatchObject(expected);

      projection.providerTurns = [turn({ turnTokenUsage: undefined })];
      expect(deriveThreadStatistics(projection)).toMatchObject({
        turnCount: 0,
        inputTokens: null,
        outputTokens: 2,
        partial: true,
      });
    },
  );
});
