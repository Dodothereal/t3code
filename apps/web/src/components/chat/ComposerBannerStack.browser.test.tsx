import { InfoIcon } from "lucide-react";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

function notice(title: string, group?: ComposerBannerStackItem["group"]): ComposerBannerStackItem {
  return { id: title, variant: "default", icon: <InfoIcon />, title, ...(group ? { group } : {}) };
}

function EmptyQueue() {
  return null;
}

it("keeps rows in fixed groups whatever order the notices arrive in", async () => {
  await using screen = await render(
    <ComposerBannerStack
      items={[
        notice("Goal", "activity"),
        notice("Branch changed"),
        notice("Offline", "environment"),
      ]}
      activity={<span>Tasks</span>}
      queue={<span>Queued</span>}
    />,
  );

  expect(screen.getByRole("region", { name: "Thread status" }).element().textContent).toBe(
    "OfflineBranch changedGoalTasksQueued",
  );
});

it("leaves the next attachment its own top edge when the shelf has nothing to show", async () => {
  await using screen = await render(
    <ComposerBanner.Column>
      <ComposerBannerStack items={[]} queue={<EmptyQueue />} />
      <ComposerBanner.Attachment>
        <ComposerBanner.Root data-testid="drawer">Approval</ComposerBanner.Root>
      </ComposerBanner.Attachment>
    </ComposerBanner.Column>,
  );

  const surface = getComputedStyle(screen.getByTestId("drawer").element(), "::before");
  expect(surface.borderTopWidth).toBe("1px");
  expect(surface.borderTopLeftRadius).not.toBe("0px");
});
