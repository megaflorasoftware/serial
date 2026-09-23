// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRestoreArticleProgress } from "~/lib/hooks/useRestoreArticleProgress";

vi.mock("~/lib/scroll", () => ({ getScrollContainer: () => document.body }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Array<ReturnType<typeof createRoot>> = [];
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  document.body.scrollTo = vi.fn();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.restoreAllMocks();
});

function Restore(props: Parameters<typeof useRestoreArticleProgress>[0]) {
  useRestoreArticleProgress(props);
  return null;
}

function mount() {
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  return (props: Parameters<typeof useRestoreArticleProgress>[0]) =>
    act(() => root.render(createElement(Restore, props)));
}

/** Runs the two placement frames the hook waits for. */
function settleFrames() {
  act(() => {
    while (frames.length) frames.shift()!(performance.now());
  });
}

function article(html: string) {
  const element = document.createElement("article");
  element.innerHTML = `<h1 data-serial-header>Article title</h1>${html}`;
  document.body.append(element);
  return element;
}

const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, i) => `<p>Paragraph ${i}</p>`).join("");

const scrollTo = () => document.body.scrollTo as ReturnType<typeof vi.fn>;

it.each([0, 12])(
  "reveals an empty article shell at the top with saved progress %i",
  (progress) => {
    const element = article("<h6 data-serial-header>Author</h6><div></div>");
    const render = mount();
    render({
      contentId: "empty",
      articleElement: element,
      progress,
      ready: false,
    });
    expect(element.style.visibility).toBe("");
    expect(scrollTo()).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
  },
);

it("places a local body before the server answers and reveals it", () => {
  const element = article(paragraphs(6));
  const render = mount();
  render({
    contentId: "local",
    articleElement: element,
    progress: 3,
    ready: false,
  });
  expect(element.style.visibility).toBe("hidden");
  settleFrames();
  expect(element.style.visibility).toBe("");
  expect(scrollTo()).toHaveBeenCalledTimes(1);
});

it("keeps a body placeholder visible and places once content replaces it", async () => {
  const element = article("<div data-reader-content-pending></div>");
  const render = mount();
  render({
    contentId: "pending",
    articleElement: element,
    progress: 2,
    ready: true,
  });
  expect(element.style.visibility).toBe("");
  expect(scrollTo()).not.toHaveBeenCalled();
  await act(async () => {
    element.querySelector("[data-reader-content-pending]")!.remove();
    element.insertAdjacentHTML("beforeend", paragraphs(4));
    await Promise.resolve();
  });
  expect(element.style.visibility).toBe("hidden");
  settleFrames();
  expect(element.style.visibility).toBe("");
  expect(scrollTo()).toHaveBeenCalledTimes(1);
});

it("re-places at the server's progress in place when the user has not interacted", async () => {
  const element = article(paragraphs(6));
  const render = mount();
  const props = { contentId: "server", articleElement: element, progress: 1 };
  render({ ...props, ready: false });
  settleFrames();
  expect(scrollTo()).toHaveBeenCalledTimes(1);

  render({ ...props, progress: 4, ready: true });
  expect(element.style.visibility).toBe("");
  settleFrames();
  expect(scrollTo()).toHaveBeenCalledTimes(2);
  expect(element.style.visibility).toBe("");

  // The server has answered; a later body swap leaves the scroll alone.
  await act(async () => {
    element.innerHTML = `<h1 data-serial-header>Title</h1>${paragraphs(9)}`;
    await Promise.resolve();
  });
  settleFrames();
  expect(scrollTo()).toHaveBeenCalledTimes(2);
});

it("leaves the scroll alone once the user has interacted", () => {
  const element = article(paragraphs(6));
  const render = mount();
  const props = { contentId: "reading", articleElement: element, progress: 1 };
  render({ ...props, ready: false });
  settleFrames();
  expect(scrollTo()).toHaveBeenCalledTimes(1);

  act(() => document.body.dispatchEvent(new Event("wheel")));
  render({ ...props, progress: 5, ready: true });
  settleFrames();
  expect(scrollTo()).toHaveBeenCalledTimes(1);
  expect(element.style.visibility).toBe("");
});

it("places a new content id from scratch after an earlier one settled", () => {
  const element = article(paragraphs(6));
  const render = mount();
  render({
    contentId: "first",
    articleElement: element,
    progress: 2,
    ready: true,
  });
  settleFrames();
  expect(scrollTo()).toHaveBeenCalledTimes(1);
  render({
    contentId: "second",
    articleElement: element,
    progress: 0,
    ready: false,
  });
  expect(scrollTo()).toHaveBeenCalledTimes(2);
  expect(scrollTo()).toHaveBeenLastCalledWith({ top: 0, behavior: "instant" });
});
