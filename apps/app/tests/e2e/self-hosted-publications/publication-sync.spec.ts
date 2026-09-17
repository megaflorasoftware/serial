import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import {
  readPublicationConnection as connection,
  pdsControl,
  seedPublication,
  seedRemoteSubscription,
  seedLocalPublication,
  localPublicationOrigins,
  SUBSCRIPTION_COLLECTION,
  fillPublicationQuota,
  resumePublicationOnboarding,
  readPublicationUser,
} from "../fixtures/publication-sync";
import { signUp } from "../fixtures/auth";
import { openSidebar } from "../fixtures/sidebar";
import { PUBLICATIONS_APP_PORT } from "../fixtures/ports";

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
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
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
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
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
