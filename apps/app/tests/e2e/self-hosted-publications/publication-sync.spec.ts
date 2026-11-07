import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, test } from "@playwright/test";
import { feedItems, feedOrigins, user } from "../../../src/server/db/schema";
import {
  readPublicationConnection as connection,
  fillPublicationQuota,
  localPublicationOrigins,
  pdsControl,
  readPublicationUser,
  resumePublicationOnboarding,
  seedLocalPublication,
  seedPublication,
  seedRemoteSubscription,
  SUBSCRIPTION_COLLECTION,
  withPublicationDatabase,
} from "../fixtures/publication-sync";
import { signUp } from "../fixtures/auth";
import { openSidebar } from "../fixtures/sidebar";
import { PUBLICATIONS_APP_PORT } from "../fixtures/ports";
import type { Page } from "@playwright/test";

async function refreshSources(
  page: Page,
  due?: { userId: string; feedId?: number },
) {
  if (due) {
    // Advance the real schedule instead of waiting for rounded UI cooldowns.
    await withPublicationDatabase(async (db) => {
      await db
        .update(user)
        .set({ nextRefreshAt: null })
        .where(eq(user.id, due.userId));
      if (due.feedId !== undefined) {
        await db
          .update(feedOrigins)
          .set({ nextFetchAt: null })
          .where(eq(feedOrigins.feedId, due.feedId));
      }
    });
  }
  const response = await page.request.post("/api/rpc/initial/fetchDueSources", {
    data: { json: { trigger: "manual" } },
  });
  expect(response.ok()).toBe(true);
}

async function openAtmosphere(page: Page) {
  await page.goto("/");
  await expect(async () => {
    await openSidebar(page);
    await expect(
      page.getByRole("button", { name: "Connections", exact: true }).first(),
    ).toBeInViewport();
  }).toPass({ timeout: 20_000 });
  await page
    .getByRole("button", { name: "Connections", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /^Atmosphere/ }).click();
  await expect(page.getByText("Connect your Atmosphere account")).toBeVisible();
}

async function linkUser(page: Page) {
  const suffix = randomBytes(12)
    .toString("hex")
    .replaceAll("0", "a")
    .replaceAll("1", "b")
    .replaceAll("8", "c")
    .replaceAll("9", "d");
  const did = `did:plc:${suffix}`;
  await signUp({
    page,
    name: "Publication Tester",
    email: `${suffix}@example.com`,
    password: "testpassword123",
  });
  await openAtmosphere(page);
  await page.getByLabel("Connect with your Atmosphere handle").fill(did);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("link", { name: "Approve", exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`127\\.0\\.0\\.1:${PUBLICATIONS_APP_PORT}`),
  );
  await expect
    .poll(async () => (await connection(did))?.scopes)
    .toBe("atproto");
  return did;
}

test("real linking and consent denial preserve settings; approval persists the broader grant", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const did = await linkUser(page);
  const beforeConsent = await connection(did);
  expect(beforeConsent).toMatchObject({
    importSubscriptions: false,
    exportSubscriptions: false,
  });
  expect(beforeConsent?.session).toBeTruthy();
  expect(beforeConsent?.session).not.toContain("access_token");
  await openAtmosphere(page);
  await page.getByRole("radio", { name: "Bidirectional", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("link", { name: "Deny", exact: true }).click();
  await expect
    .poll(async () => (await connection(did))?.scopes)
    .toBe("atproto");
  expect(await connection(did)).toMatchObject({
    importSubscriptions: false,
    exportSubscriptions: false,
    session: beforeConsent?.session,
  });
  await openAtmosphere(page);
  await page.getByRole("radio", { name: "Bidirectional", exact: true }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("link", { name: "Approve", exact: true }).click();
  await expect
    .poll(async () => (await connection(did))?.scopes)
    .toContain("include:site.standard.authSocial");
  await page.reload();
  await openAtmosphere(page);
  await expect(
    page.getByRole("radio", { name: "Bidirectional", exact: true }),
  ).toBeChecked();
});

for (const method of [
  "None",
  "Import to Serial",
  "Export to Atmosphere",
  "Bidirectional",
] as const) {
  test(`${method} applies its directions through the real PDS after leaving the pane`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const did = await linkUser(page);
    const linked = await connection(did);
    expect(linked?.userId).toBeTruthy();
    const userId = linked!.userId!;
    const remote = await seedPublication(did, "remote");
    const local = await seedPublication(did, "local");
    await seedRemoteSubscription(did, "remote-sub", remote.uri);
    await seedLocalPublication(userId, local);
    if (method !== "None") await pdsControl({ operation: "pause", repo: did });
    await openAtmosphere(page);
    await page.getByRole("radio", { name: method, exact: true }).click();
    // None is the initial method. Change its independent preference to exercise Save.
    if (method === "None")
      await page.getByRole("radio", { name: "Inactive", exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    if (method === "Export to Atmosphere" || method === "Bidirectional") {
      await page.getByRole("link", { name: "Approve", exact: true }).click();
      await expect
        .poll(async () => (await connection(did))?.exportSubscriptions)
        .toBe(true);
    } else {
      await expect(
        page.getByText("Settings saved", { exact: true }),
      ).toBeVisible();
    }
    if (method !== "None") {
      await expect
        .poll(
          async () =>
            (await pdsControl({ operation: "inspect", repo: did })).waiting,
        )
        .toBe(true);
      expect((await connection(did))?.subscriptionJobResult).toBeNull();
    }
    try {
      await page.goto("/");
      await page.reload();
    } finally {
      if (method !== "None")
        await pdsControl({ operation: "release", repo: did });
    }
    if (method !== "None") {
      await expect
        .poll(async () => (await connection(did))?.subscriptionJobResult, {
          timeout: 45_000,
        })
        .toMatchObject({ status: "completed", failed: 0 });
    } else {
      expect(await connection(did)).toMatchObject({
        importSubscriptions: false,
        exportSubscriptions: false,
        subscriptionNextAttemptAt: null,
      });
    }
    const origins = await localPublicationOrigins(userId);
    expect(origins.some((row) => row.locator === remote.uri)).toBe(
      method === "Import to Serial" || method === "Bidirectional",
    );
    expect(origins.some((row) => row.locator === local.uri)).toBe(true);
    const state = await pdsControl({ operation: "inspect", repo: did });
    const subscriptions = state.records.filter((record) =>
      record.uri.includes(`/${SUBSCRIPTION_COLLECTION}/`),
    );
    expect(
      subscriptions.some((record) => record.value.publication === local.uri),
    ).toBe(method === "Export to Atmosphere" || method === "Bidirectional");
    expect(
      subscriptions.some((record) => record.value.publication === remote.uri),
    ).toBe(true);
    if (method === "None" || method === "Import to Serial")
      expect(
        state.writes.filter((write) => write.uri.startsWith(`at://${did}/`)),
      ).toEqual([]);
    if (method === "Bidirectional") {
      await pdsControl({
        operation: "delete",
        repo: did,
        collection: SUBSCRIPTION_COLLECTION,
        rkey: "remote-sub",
      });
      await page.goto("/");
      await refreshSources(page, { userId });
      await expect
        .poll(
          async () =>
            (await localPublicationOrigins(userId)).some(
              (row) => row.locator === remote.uri,
            ),
          { timeout: 30_000 },
        )
        .toBe(false);
      await page.goto("/feeds");
      await expect(
        page.locator("main").getByRole("button", { name: /Local publication/ }),
      ).toBeVisible();
      await page.keyboard.press("s");
      await page.keyboard.press("d");
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", { name: "Delete Feeds" }),
      ).toBeVisible();
      await dialog.getByRole("button", { name: "Delete", exact: true }).click();
      await expect(dialog).toBeHidden();
      await page.goto("/");
      await refreshSources(page, { userId });
      await expect
        .poll(
          async () =>
            (
              await pdsControl({ operation: "inspect", repo: did })
            ).records.filter((record) =>
              record.uri.includes(`/${SUBSCRIPTION_COLLECTION}/`),
            ),
          { timeout: 30_000 },
        )
        .toEqual([]);
      const finalState = await pdsControl({ operation: "inspect", repo: did });
      expect(
        finalState.writes.some(
          (write) =>
            write.method === "com.atproto.repo.deleteRecord" &&
            write.uri.startsWith(`at://${did}/`),
        ),
      ).toBe(true);
    }
  });
}

test("imports beyond the real main-instance quota become inactive", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const did = await linkUser(page);
  const userId = (await connection(did))!.userId!;
  await fillPublicationQuota(userId, 2499);
  const publications: string[] = [];
  for (let index = 0; index < 3; index++) {
    const publication = await seedPublication(did, `quota-${index}`);
    publications.push(publication.uri);
    await seedRemoteSubscription(did, `quota-sub-${index}`, publication.uri);
  }
  await openAtmosphere(page);
  await page
    .getByRole("radio", { name: "Import to Serial", exact: true })
    .click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => (await connection(did))?.subscriptionJobResult, {
      timeout: 45_000,
    })
    .toMatchObject({
      status: "completed",
      imported: 3,
      inactive: 2,
      failed: 0,
    });
  const imported = (await localPublicationOrigins(userId)).filter((row) =>
    publications.includes(row.locator),
  );
  expect(imported).toHaveLength(3);
  expect(imported.filter((row) => row.active)).toHaveLength(1);
});

test("onboarding resumes after real consent denial and completes after approval", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const did = await linkUser(page);
  const userId = (await connection(did))!.userId!;
  await resumePublicationOnboarding(userId);
  await page.goto("/");
  const syncHeading = page.getByRole("heading", {
    name: "Your Atmosphere subscriptions",
    exact: true,
  });
  await expect(syncHeading).toBeVisible();
  await page.getByRole("radio", { name: "Bidirectional", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("link", { name: "Deny", exact: true }).click();
  await expect(syncHeading).toBeVisible();
  expect(await readPublicationUser(userId)).toMatchObject({
    onboardingComplete: false,
    onboardingStep: "2026-09-16-atmosphere-sync-setup",
  });
  await page.reload();
  await expect(syncHeading).toBeVisible();
  expect(await connection(did)).toMatchObject({
    importSubscriptions: false,
    exportSubscriptions: false,
  });
  await page.getByRole("radio", { name: "Bidirectional", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("link", { name: "Approve", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "That's it!", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await readPublicationUser(userId))?.onboardingComplete)
    .toBe(true);
  expect(await connection(did)).toMatchObject({
    importSubscriptions: true,
    exportSubscriptions: true,
  });
  await page.reload();
  await expect(syncHeading).toHaveCount(0);
});

test("manual Jetstream recovery imports, updates, and retains deleted reader items", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const did = await linkUser(page);
  const userId = (await connection(did))!.userId!;
  await expect
    .poll(async () => (await readPublicationUser(userId))!.lastActiveAt)
    .not.toBeNull();
  const publication = await seedPublication(did, "content");
  const feed = await seedLocalPublication(userId, publication);
  const put = async (title: string) =>
    pdsControl({
      operation: "put",
      repo: did,
      collection: "site.standard.document",
      rkey: "post",
      value: {
        $type: "site.standard.document",
        site: publication.uri,
        title,
        path: "/post",
        publishedAt: new Date().toISOString(),
        content: {
          $type: "pub.leaflet.content",
          pages: [
            {
              $type: "pub.leaflet.pages.linearDocument",
              blocks: [
                {
                  block: { $type: "pub.leaflet.blocks.text", plaintext: title },
                },
              ],
            },
          ],
        },
      },
    });
  const items = () =>
    withPublicationDatabase((db) =>
      db.select().from(feedItems).where(eq(feedItems.feedId, feed.id)),
    );
  const refresh = (due = true) =>
    refreshSources(page, due ? { userId, feedId: feed.id } : undefined);
  await put("Initial document");
  await refresh(false);
  expect(await items()).toEqual([]);
  await refresh();
  await expect
    .poll(async () => (await items()).map((item) => item.title), {
      timeout: 30000,
    })
    .toEqual(["Initial document"]);
  const initial = (await items())[0]!;
  const activity = (await readPublicationUser(userId))!.lastActiveAt;
  expect(activity).not.toBeNull();
  await put("Updated document");
  await refresh();
  await expect
    .poll(async () => (await items()).map((item) => item.title), {
      timeout: 30000,
    })
    .toEqual(["Updated document"]);
  expect((await items())[0]!.id).toBe(initial.id);
  expect((await readPublicationUser(userId))!.lastActiveAt).toEqual(activity);
  // A later explicit refresh can record activity after the write throttle expires.
  await withPublicationDatabase((db) =>
    db
      .update(user)
      .set({ lastActiveAt: new Date(Date.now() - 5 * 60 * 1000) })
      .where(eq(user.id, userId)),
  );
  await pdsControl({
    operation: "delete",
    repo: did,
    collection: "site.standard.document",
    rkey: "post",
  });
  await refresh();
  await expect
    .poll(async () =>
      (await readPublicationUser(userId))!.lastActiveAt!.getTime(),
    )
    .toBeGreaterThan(activity!.getTime());
  expect((await items()).map((item) => item.id)).toEqual([initial.id]);
});
