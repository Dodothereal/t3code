import { InfoIcon } from "lucide-react";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ComposerBannerStack, type ComposerBannerStackItem } from "./ComposerBannerStack";

function notice(title: string, group?: ComposerBannerStackItem["group"]): ComposerBannerStackItem {
  return { id: title, variant: "default", icon: <InfoIcon />, title, ...(group ? { group } : {}) };
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
