import { randomUUID } from "node:crypto";
import type { Browser, Frame, Page } from "playwright";
import { ScannerError } from "./contracts.js";
import type {
  Observation,
  FrameContext,
  ScannerLimits,
  ScannerOptions,
  Verification,
  VerificationReason,
} from "./contracts.js";
import { observeDom, verifyDom } from "./dom.js";
import {
  boundObservation,
  resolveOptions,
  safeFrameUrl,
  selectorCandidates,
  validateUrl,
} from "./helpers.js";

interface FrameProof {
  frame: Frame;
  revision: number;
}

export class BrowserScanner {
  readonly #browser: Browser;
  readonly #page: Page;
  readonly #limits: ScannerLimits;
  readonly #revisions = new WeakMap<Frame, number>();
  #proofs = new Map<string, FrameProof>();
  #mainFrameId: string | null = null;
  #closed = false;
  #busy = false;

  private constructor(browser: Browser, page: Page, limits: ScannerLimits) {
    this.#browser = browser;
    this.#page = page;
    this.#limits = limits;
    page.on("framenavigated", (frame) => {
      this.#revisions.set(frame, this.#revision(frame) + 1);
    });
  }

  static async open(url: string, options: ScannerOptions = {}): Promise<BrowserScanner> {
    const target = validateUrl(url);
    const limits = resolveOptions(options);
    let browser: Browser | undefined;
    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({
        channel: "chrome",
        headless: limits.headless,
        timeout: limits.timeoutMs,
      });
      const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
      context.setDefaultTimeout(limits.timeoutMs);
      const page = await context.newPage();
      const scanner = new BrowserScanner(browser, page, limits);
      await page.goto(target, { waitUntil: "domcontentloaded", timeout: limits.timeoutMs });
      validateUrl(page.url());
      return scanner;
    } catch {
      await browser?.close().catch(() => undefined);
      throw new ScannerError("OPEN_FAILED");
    }
  }

  async observe(): Promise<Observation> {
    return this.#operation(async () => {
      this.#proofs.clear();
      this.#mainFrameId = null;
      const all = this.#page.frames();
      // Parent-first order keeps every retained child's frame context complete.
      const selected = [this.#page.mainFrame()];
      for (let i = 0; i < selected.length && selected.length < this.#limits.maxFrames; i++) {
        const frame = selected[i];
        if (frame)
          selected.push(...frame.childFrames().slice(0, this.#limits.maxFrames - selected.length));
      }
      const ids = new Map(selected.map((frame) => [frame, randomUUID()]));
      const observation: Observation = {
        trust: "untrusted-page-data",
        scope: "dom-prevalidation-only",
        observedAt: new Date().toISOString(),
        mainFrameId: ids.get(this.#page.mainFrame()) ?? null,
        title: null,
        titleTruncated: false,
        frames: [],
        elements: [],
        truncated: {
          elements: false,
          frames: all.length > selected.length,
          bytes: false,
          dom: false,
        },
      };
      for (const frame of selected) {
        const id = ids.get(frame);
        if (!id) continue;
        const parent = frame.parentFrame();
        let depth = 0;
        for (let ancestor = parent; ancestor; ancestor = ancestor.parentFrame()) depth++;
        const context: FrameContext = {
          id,
          parentId: parent ? (ids.get(parent) ?? null) : null,
          depth,
          url: safeFrameUrl(frame.url()),
          proof: "unavailable",
          title: null,
          titleTruncated: false,
        };
        observation.frames.push(context);
        if (
          frame.isDetached() ||
          context.url === "[unsupported-url]" ||
          (parent && !context.parentId)
        )
          continue;
        const revision = this.#revision(frame);
        try {
          const result = await frame.evaluate(observeDom, {
            maxElements: this.#limits.maxElements - observation.elements.length,
            maxTextLength: this.#limits.maxTextLength,
            maxDomNodes: this.#limits.maxDomNodes,
          });
          if (frame.isDetached() || revision !== this.#revision(frame)) continue;
          context.proof = "observed-document";
          context.title = result.title;
          context.titleTruncated = result.titleTruncated;
          if (id === observation.mainFrameId) {
            observation.title = result.title;
            observation.titleTruncated = result.titleTruncated;
          }
          this.#proofs.set(id, { frame, revision });
          observation.elements.push(
            ...result.elements.map((element) => ({
              ...element,
              frameId: id,
              candidates: selectorCandidates(element),
            })),
          );
          observation.truncated.elements ||= result.truncated;
          observation.truncated.dom ||= result.domTruncated;
        } catch {
          // An inaccessible or navigating frame is explicitly unproven. No fallback to main.
        }
      }
      boundObservation(observation, this.#limits.maxBytes);
      const retained = new Set(observation.frames.map((frame) => frame.id));
      for (const id of this.#proofs.keys()) if (!retained.has(id)) this.#proofs.delete(id);
      this.#mainFrameId = observation.mainFrameId;
      return observation;
    });
  }

  async verify(selector: string, frameId?: string): Promise<Verification> {
    return this.#operation(async () => {
      const id = frameId ?? this.#mainFrameId;
      const response = (
        reason: VerificationReason,
        count: number | null = null,
        visible: boolean | null = null,
      ): Verification => ({
        trust: "untrusted-page-data",
        scope: "dom-prevalidation-only",
        frameId: id?.slice(0, 100) ?? null,
        count,
        unique: count === 1,
        visible,
        accepted: reason === "unique-visible",
        reason,
        observedAt: new Date().toISOString(),
      });
      const proof = id ? this.#proofs.get(id) : undefined;
      if (!proof) return response("frame-unproven");
      const fresh = (): boolean =>
        !proof.frame.isDetached() && this.#revision(proof.frame) === proof.revision;
      if (!fresh()) return response("stale-frame");
      if (typeof selector !== "string" || selector.length === 0 || selector.length > 2048)
        return response("invalid-selector");
      try {
        const result = await proof.frame.evaluate(verifyDom, selector);
        let visible = result.visible;
        if (visible) {
          // A visible child node inside a hidden iframe is not a usable target.
          for (let frame = proof.frame; frame.parentFrame(); frame = frame.parentFrame() ?? frame) {
            const owner = await frame.frameElement();
            try {
              if (!(await owner.isVisible())) {
                visible = false;
                break;
              }
            } finally {
              await owner.dispose();
            }
          }
        }
        if (!fresh()) return response("stale-frame");
        const reason =
          result.reason === "unique-visible" && !visible ? "not-visible" : result.reason;
        return response(reason, result.count, visible);
      } catch {
        return response("stale-frame");
      }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#proofs.clear();
    this.#mainFrameId = null;
    await this.#browser.close().catch(() => undefined);
  }

  #revision(frame: Frame): number {
    return this.#revisions.get(frame) ?? 0;
  }

  #assertOpen(): void {
    if (this.#closed || this.#page.isClosed()) throw new ScannerError("CLOSED");
  }

  async #operation<T>(work: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    if (this.#busy) throw new ScannerError("BUSY");
    this.#busy = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.close();
            reject(new ScannerError("TIMEOUT"));
          }, this.#limits.timeoutMs);
        }),
      ]);
      this.#assertOpen();
      return result;
    } catch (error) {
      if (error instanceof ScannerError) throw error;
      throw new ScannerError("OBSERVATION_FAILED");
    } finally {
      if (timer) clearTimeout(timer);
      this.#busy = false;
    }
  }
}
