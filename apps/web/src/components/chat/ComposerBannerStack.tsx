import { InfoIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";
import { observeResize } from "~/lib/observeResize";

/**
 * Where a notice sits on the shelf. Groups keep a fixed order, so rows never trade places as
 * states come and go: the machine first, then what needs you, then what the agent is doing.
 */
export type ComposerBannerGroup = "environment" | "attention" | "activity";

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly group?: ComposerBannerGroup;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

interface ComposerBannerStackProps {
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
  /** The agent's tasks or the sync status, last in the activity group. */
  readonly activity?: ReactNode;
  /** Queued messages, nearest the composer. */
  readonly queue?: ReactNode;
}

const GROUPS = ["environment", "attention", "activity"] as const;

/**
 * Everything above the composer, on one attached surface: one row per concern, nothing hidden
 * behind another card, nothing floating over the transcript.
 */
export function ComposerBannerStack({ items, activity, queue }: ComposerBannerStackProps) {
  const bands = GROUPS.map((group) => ({
    group,
    items: items.filter((item) => (item.group ?? "attention") === group),
  }));
  return (
    <ComposerBanner.Attachment
      data-composer-banner-stack="true"
      className="not-has-[[data-composer-shelf-band]:not(:empty)]:hidden"
    >
      <ComposerBanner.Root
        role="region"
        aria-label="Thread status"
        density="comfortable"
        data-chat-composer-collapsed-controls="true"
        className="[&>[data-composer-shelf-band]:not(:empty)~[data-composer-shelf-band]:not(:empty)]:border-t"
      >
        {bands.map((band) => (
          <ShelfBand key={band.group} name={band.group}>
            {band.items.map((item) => (
              <ShelfRow key={item.id} item={item} />
            ))}
            {band.group === "activity" ? activity : null}
          </ShelfBand>
        ))}
        <ShelfBand name="queue">{queue}</ShelfBand>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function ShelfBand({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <div
      data-composer-shelf-band={name}
      className="-mx-1 border-(--chat-composer-attached-outline) px-1 py-0.5 empty:hidden"
    >
      {children}
    </div>
  );
}

function NoticeText({
  children,
  className,
  detailsLabel,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly detailsLabel: string;
}) {
  const textRef = useRef<HTMLSpanElement>(null);
  const detailsRef = useRef<HTMLButtonElement>(null);
  const [showDetails, setShowDetails] = useState(false);

  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => {
      // Ignore the space taken by the details button itself so it cannot
      // sustain its own overflow after the text would otherwise fit.
      const recoveredWidth = detailsRef.current ? detailsRef.current.offsetWidth + 4 : 0;
      const hidden = getComputedStyle(text).position === "absolute";
      setShowDetails(
        hidden ||
          [text, ...text.querySelectorAll("*")].some(
            (element) => element.scrollWidth > element.clientWidth + recoveredWidth,
          ),
      );
    };
    measure();
    const stopObserving = observeResize(text, measure);
    const mutations = new MutationObserver(measure);
    mutations.observe(text, { childList: true, subtree: true, characterData: true });
    return () => {
      stopObserving();
      mutations.disconnect();
    };
  }, []);

  return (
    <span className="contents">
      <span ref={textRef} className={className}>
        {children}
      </span>
      {showDetails ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                ref={detailsRef}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={detailsLabel}
                className="flex-none"
              />
            }
          >
            <InfoIcon />
          </PopoverTrigger>
          <PopoverPopup
            aria-label="Notice details"
            tooltipStyle
            side="top"
            className="max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal wrap-anywhere [--inline-button-text-align:start] [--inline-button-white-space:normal] [&_[data-slot=inline-button]]:max-w-full"
          >
            <ComposerBanner.Scroll className="max-h-[min(var(--available-height),24rem,40dvh)]">
              {children}
            </ComposerBanner.Scroll>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}

function ShelfRow({ item }: { readonly item: ComposerBannerStackItem }) {
  const problem = item.variant === "error" || item.variant === "warning";
  return (
    <div
      role={problem ? "alert" : undefined}
      data-composer-shelf-row={item.variant}
      className={cn(
        problem && "rounded-xl",
        item.variant === "error" &&
          "bg-destructive/8 [&>[data-composer-banner-row]>[data-slot=composer-banner-icon]]:text-destructive-foreground",
        item.variant === "warning" &&
          "bg-warning/8 [&>[data-composer-banner-row]>[data-slot=composer-banner-icon]]:text-warning-foreground",
      )}
    >
      <ComposerBanner.Row layout={item.group === "activity" ? "inline" : "wrap-actions"}>
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="whitespace-nowrap">
          <NoticeText
            detailsLabel="Show title details"
            className="min-w-0 truncate font-medium leading-7 sm:leading-6"
          >
            {item.title}
          </NoticeText>
          {item.description ? (
            <NoticeText
              detailsLabel="Show notice details"
              className="w-0 min-w-0 grow truncate text-muted-foreground @max-[400px]:sr-only"
            >
              {item.description}
            </NoticeText>
          ) : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions>
            {item.actions}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss
                aria-label={item.dismissLabel ?? "Dismiss warning"}
                onClick={item.onDismiss}
              />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </div>
  );
}
