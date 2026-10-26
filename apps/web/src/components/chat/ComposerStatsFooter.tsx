import { GaugeIcon, InfoIcon, PauseIcon } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import type { ThreadStatistics } from "../../lib/threadStatistics";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatDecimal(value: number): string {
  return value > 0 && value < 0.1 ? "<0.1" : decimal.format(value);
}

function formatSeconds(value: number): string {
  return `${formatDecimal(value / 1_000)}s`;
}

function formatPercentage(value: number): string {
  return `${formatDecimal(value)}%`;
}

type Activity = "generating" | "tools" | "waiting" | "idle";

const valueWidths = {
  count: "min-w-[2ch]",
  time: "min-w-[6ch]",
  rate: "min-w-[6ch]",
  percentage: "min-w-[4ch]",
  tokens: "min-w-[5ch]",
};

const rateActivityDescriptions: Record<Activity, string> = {
  generating: "Generating. This is an approximate average, not an instantaneous speed.",
  tools: "Tools are running; there is no new model generation. The last measured average is held.",
  waiting: "Waiting; there is no new model generation. The last measured average is held.",
  idle: "Last measured average output rate; this is not an instantaneous speed.",
};

function StatDigit({ character }: { readonly character: string }) {
  const currentRef = useRef<HTMLSpanElement>(null);
  const outgoingRef = useRef<HTMLSpanElement>(null);
  const previousCharacter = useRef(character);

  // oxlint-disable-next-line t3code/react-effect-budget -- Synchronize and cancel glyph DOM animations before paint.
  useLayoutEffect(() => {
    const previous = previousCharacter.current;
    previousCharacter.current = character;
    const current = currentRef.current;
    const outgoing = outgoingRef.current;
    if (current === null || outgoing === null) return;
    outgoing.textContent = "";
    if (
      previous === character ||
      !/^\d$/.test(previous) ||
      !/^\d$/.test(character) ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;

    outgoing.textContent = previous;
    const options = { duration: 240, easing: "cubic-bezier(0.4, 0, 0.2, 1)" };
    const incomingAnimation = current.animate(
      [
        { transform: "translateY(100%)", filter: "blur(0px)" },
        { offset: 0.45, filter: "blur(0.5px)" },
        { transform: "translateY(0)", filter: "blur(0px)" },
      ],
      options,
    );
    const outgoingAnimation = outgoing.animate(
      [
        { transform: "translateY(0)", filter: "blur(0px)" },
        { offset: 0.45, filter: "blur(0.5px)" },
        { transform: "translateY(-100%)", filter: "blur(0px)" },
      ],
      options,
    );
    outgoingAnimation.onfinish = () => {
      outgoing.textContent = "";
    };
    return () => {
      incomingAnimation.cancel();
      outgoingAnimation.cancel();
      outgoing.textContent = "";
    };
  }, [character]);

  return (
    <span className="relative inline-grid h-lh overflow-hidden leading-tight">
      <span ref={currentRef} className="col-start-1 row-start-1">
        {character}
      </span>
      <span ref={outgoingRef} className="pointer-events-none absolute inset-0" />
    </span>
  );
}

function StatNumber({ text }: { readonly text: string }) {
  return (
    <>
      <span aria-hidden="true" className="inline-flex items-baseline">
        {Array.from(text, (character, index) => (
          <StatDigit key={text.length - index} character={character} />
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}

function StatDetail({
  children,
  description,
  className,
  focusable = false,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly className?: string;
  readonly focusable?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        tabIndex={focusable ? 0 : -1}
        render={<span className={cn("whitespace-nowrap font-medium", className)} />}
      >
        {children}
        <span className="sr-only"> {description}</span>
      </TooltipTrigger>
      <TooltipPopup>{description}</TooltipPopup>
    </Tooltip>
  );
}

function StatValue({
  value,
  format = formatDecimal,
  unavailableReason,
  estimateReason,
  width = "count",
  rateActivity,
}: {
  readonly value: number | null;
  readonly format?: (value: number) => string;
  readonly unavailableReason: string;
  readonly estimateReason?: string | undefined;
  readonly width?: keyof typeof valueWidths;
  readonly rateActivity?: Activity;
}) {
  const available = value !== null && Number.isFinite(value) && value >= 0;
  const formatted = available ? format(value) : "–";
  const held = rateActivity === "tools" || rateActivity === "waiting";
  const description = [
    available
      ? (estimateReason ??
        (rateActivity !== undefined
          ? "Average over measured output; unmeasured turns and recorded tool/wait time are excluded."
          : "Recorded value for this thread."))
      : unavailableReason,
    rateActivity !== undefined
      ? !available && held
        ? "There is no new model generation, and no measured output rate is available yet."
        : rateActivityDescriptions[rateActivity]
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <StatDetail
      description={description}
      focusable={rateActivity !== undefined}
      className={cn(
        "inline-flex items-baseline text-xs text-foreground",
        rateActivity !== undefined &&
          "items-center gap-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-hidden motion-safe:transition-colors motion-safe:duration-200",
        rateActivity !== undefined && (held ? "text-foreground/75" : "text-foreground"),
      )}
    >
      {rateActivity !== undefined ? (
        held ? (
          <PauseIcon aria-hidden="true" className="size-3 shrink-0" />
        ) : (
          <GaugeIcon aria-hidden="true" className="size-3 shrink-0" />
        )
      ) : null}
      <span
        className={cn("inline-flex items-baseline justify-end tabular-nums", valueWidths[width])}
      >
        {available && estimateReason ? (
          <>
            <span aria-hidden="true">~</span>
            <span className="sr-only">estimated </span>
          </>
        ) : null}
        <StatNumber text={formatted} />
        {!available ? <span className="sr-only"> unavailable.</span> : null}
      </span>
      {rateActivity !== undefined ? (
        <>
          <span aria-hidden="true" className="text-3xs font-normal">
            tok/s
          </span>
          <span className="sr-only"> tokens per second.</span>
        </>
      ) : null}
    </StatDetail>
  );
}

function StatGroup({
  children,
  first = false,
}: {
  readonly children: ReactNode;
  readonly first?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      {!first ? <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border/70" /> : null}
      <span>{children}</span>
    </span>
  );
}

export function ComposerStatsFooter({
  statistics,
  activity = "idle",
}: {
  readonly statistics: ThreadStatistics;
  readonly activity?: Activity;
}) {
  const estimatedFields: ReadonlyArray<keyof ThreadStatistics> = statistics.estimatedFields;
  const hasEstimates = estimatedFields.length > 0;
  const noteDescription = [
    hasEstimates
      ? "Values marked ~ are estimates; each value's tooltip explains its source. Input marked + is a lower bound."
      : null,
    statistics.partial
      ? "Some history or usage is unavailable; totals cover only available data."
      : null,
  ]
    .filter((description) => description !== null)
    .join(" ");

  return (
    <div className="min-w-0 max-w-full bg-background py-1">
      <div
        role="group"
        aria-label="Thread statistics"
        tabIndex={0}
        className="min-w-0 max-w-full overflow-x-auto overscroll-x-contain bg-background text-xs leading-5 font-normal text-foreground/70 tabular-nums focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset focus-visible:outline-hidden [scrollbar-width:thin]"
      >
        <div className="flex w-max min-w-full flex-nowrap items-center justify-center gap-1.5 whitespace-nowrap px-2 py-0.5">
          <StatGroup first>
            <StatValue
              value={statistics.turnCount}
              unavailableReason="Turn count is unavailable."
            />{" "}
            <span className="inline-block min-w-[5ch]">
              {statistics.turnCount === 1 ? "turn" : "turns"}
            </span>
            <span aria-hidden="true"> · </span>
            <StatValue
              value={statistics.stepCount}
              unavailableReason="The provider has not reported a model step count for this thread."
              estimateReason={
                estimatedFields.includes("stepCount")
                  ? "Estimated from recorded thread activity; some model steps may be missing."
                  : undefined
              }
            />{" "}
            <span className="inline-block min-w-[5ch]">
              {statistics.stepCount === 1 ? "step" : "steps"}
            </span>
          </StatGroup>
          <StatGroup>
            <span aria-hidden="true">LLM </span>
            <span className="sr-only">Model generation time: </span>
            <StatValue
              value={statistics.llmDurationMs}
              width="time"
              format={formatSeconds}
              unavailableReason="Model generation time is unavailable for this thread."
              estimateReason={
                estimatedFields.includes("llmDurationMs")
                  ? "Estimated time outside recorded tool activity and waits; may include unrecorded overhead."
                  : undefined
              }
            />
          </StatGroup>
          <StatGroup>
            <span aria-hidden="true">TTFT </span>
            <span className="sr-only">Average time to first token: </span>
            <StatValue
              value={statistics.averageTtftMs}
              width="time"
              format={formatSeconds}
              unavailableReason="Average time to first token is unavailable for this thread."
              estimateReason={
                estimatedFields.includes("averageTtftMs")
                  ? "Estimated from turn start to first recorded output; includes startup and other time before output."
                  : undefined
              }
            />
          </StatGroup>
          <StatGroup>
            <StatValue
              value={statistics.outputTokensPerSecond}
              width="rate"
              rateActivity={activity}
              unavailableReason="Output token rate is unavailable without token counts and generation timing."
              estimateReason={
                estimatedFields.includes("outputTokensPerSecond")
                  ? "Approximate average from reported tokens where available, visible assistant/reasoning text otherwise, and recorded generation timing. Unmeasured turns and recorded tool/wait time are excluded. Hidden reasoning may be missing; not a provider decode benchmark."
                  : undefined
              }
            />
          </StatGroup>
          <StatGroup>
            <span aria-hidden="true">Cache </span>
            <span className="sr-only">Cache hit rate: </span>
            <StatValue
              value={statistics.cacheHitPercent}
              width="percentage"
              format={formatPercentage}
              unavailableReason="Cache hit rate is unavailable unless the provider reports cached and total input token counts."
            />
          </StatGroup>
          <StatGroup>
            <span aria-hidden="true">In </span>
            <span className="sr-only">Input tokens: </span>
            <StatValue
              value={statistics.inputTokens}
              width="tokens"
              format={(value) =>
                `${compact.format(value)}${estimatedFields.includes("inputTokens") ? "+" : ""}`
              }
              unavailableReason="The provider has not reported input token usage for this thread."
              estimateReason={
                estimatedFields.includes("inputTokens")
                  ? "Lower bound from visible user prompt text only. Excludes context, system prompts, tools, and attachments; actual input token usage can be higher."
                  : undefined
              }
            />
            <span aria-hidden="true"> · </span>
            <span aria-hidden="true">Out </span>
            <span className="sr-only">Output tokens: </span>
            <StatValue
              value={statistics.outputTokens}
              width="tokens"
              format={compact.format}
              unavailableReason="The provider has not reported output token usage for this thread."
              estimateReason={
                estimatedFields.includes("outputTokens")
                  ? "Estimated from visible assistant and reasoning text only. Hidden, unreported reasoning is excluded."
                  : undefined
              }
            />
          </StatGroup>
          {hasEstimates || statistics.partial ? (
            <Tooltip>
              <TooltipTrigger
                aria-label={
                  statistics.partial
                    ? "About partial thread statistics"
                    : "About estimated thread statistics"
                }
                render={<Button size="icon-tiny" variant="ghost" />}
              >
                <InfoIcon aria-hidden="true" />
                <span className="sr-only">{noteDescription}</span>
              </TooltipTrigger>
              <TooltipPopup>{noteDescription}</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  );
}
