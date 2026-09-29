import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BrowserScanner } from "../src/index.js";

// Explicit opt-in: opens installed Chrome only. Never downloads a browser.
describe.runIf(process.env.BPDEV_SCANNER_CHROME_TEST === "1")(
  "installed Chrome, loopback fixture",
  () => {
    let server: Server;
    let crossOriginServer: Server;
    let origin: string;
    let crossOrigin: string;
    let scanner: BrowserScanner | undefined;
    let phase = false;

    const listen = async (instance: Server): Promise<string> => {
      await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
      const address = instance.address();
      if (!address || typeof address === "string") throw new Error("Loopback fixture unavailable");
      return `http://127.0.0.1:${address.port}`;
    };
    const stop = async (instance: Server): Promise<void> => {
      instance.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        instance.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    };

    beforeAll(async () => {
      crossOriginServer = createServer((_request, response) => {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(
          '<label for="cross">Cross field</label><input id="cross" value="CROSS_VALUE_SECRET">',
        );
      });
      crossOrigin = await listen(crossOriginServer);
      server = createServer((request, response) => {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        const path = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
        if (path === "/semantic") {
          response.end(`<!doctype html><title>Case intake — observed</title>
            <body aria-live="off">BODY_TEXT_SECRET
            <style>output, [role], [aria-live] { display:block; min-height:20px; min-width:20px }</style>
            <output></output><span id="confirmation" role="status"></span>
            <span role="status"></span><div aria-live="polite"></div>
            <x-notice role="note status"></x-notice>
            <div id="message" role="alert">Ready
              <input value="INPUT_VALUE_SECRET"><textarea>TEXTAREA_VALUE_SECRET</textarea>
              <select><option selected>SELECT_VALUE_SECRET</option></select>
              <span contenteditable>EDITABLE_VALUE_SECRET</span>
            </div>
            <input type="password" aria-live="assertive" value="PASSWORD_SECRET">
            <script>document.querySelector('output').setAttribute('value', 'OUTPUT_ATTRIBUTE_SECRET');</script>
            <iframe src="/title-child?token=TITLE_QUERY_SECRET"></iframe></body>`);
          return;
        }
        if (path === "/title-child") {
          response.end('<title>Child confirmation</title><output id="child-result"></output>');
          return;
        }
        if (path === "/title-budget") {
          response.end(`<title>${"漢".repeat(500)}</title>`);
          return;
        }
        if (path === "/semantic-many") {
          response.end(
            `<title>${"漢".repeat(600)}</title>${Array.from(
              { length: 80 },
              (_, i) =>
                `<div role="status ${"x".repeat(100)}" aria-live="${"polite".repeat(30)}" id="target-${i}">${"漢".repeat(300)}</div>`,
            ).join("")}`,
          );
          return;
        }
        if (path === "/phase") {
          response.end(phase ? "yes" : "no");
          return;
        }
        if (path === "/siblings") {
          response.end(`<div><label for="adjacent">Case reference</label> <!-- whitespace is not an element -->
            <input id="adjacent" value="SIBLING_VALUE_SECRET"></div>
            <div><label for="gap">Gap</label><span>Hint</span><input id="gap"></div>
            <div><label for="nested">Nested</label><div><input id="nested"></div></div>
            <label>Wrapped<input id="wrapped"></label>
            <div><label>No for attribute</label><input id="no-for"></div>
            <div><label for="dup-a">Duplicate label</label><input id="dup-a"></div>
            <div><label for="dup-b">Duplicate label</label><input id="dup-b"></div>
            <div><label for="earlier">Two following inputs</label><input id="earlier"><input id="later"></div>`);
          return;
        }
        if (path === "/child-next") {
          response.end('<input name="new-child">');
          return;
        }
        if (path === "/child") {
          response.end(`<input name="child" value="CHILD_VALUE_SECRET"><script>
          setInterval(async () => { if (await (await fetch('/phase')).text() === 'yes') location.replace('/child-next'); }, 50);
        </script>`);
          return;
        }
        if (path === "/many") {
          response.end(
            Array.from(
              { length: 80 },
              (_, i) => `<button name="n${i}">${"漢".repeat(300)}</button>`,
            ).join(""),
          );
          return;
        }
        if (path === "/frames") {
          response.end(`<iframe src="/child?token=FRAME_QUERY_SECRET"></iframe>
          <iframe style="display:none" src="/child?token=HIDDEN_QUERY_SECRET"></iframe>
          <iframe src="${crossOrigin}/?token=CROSS_QUERY_SECRET"></iframe>`);
          return;
        }
        response.setHeader("Set-Cookie", "fixture=COOKIE_SECRET; SameSite=Lax");
        response.end(`<!doctype html><html><body>
        <label for="generated-1">First Name</label><input id="generated-1" name="first" value="INPUT_VALUE_SECRET">
        <label for="quoted">Sam's &quot;name&quot;</label><input id="quoted">
        <label>Notes<textarea name="notes">TEXTAREA_VALUE_SECRET</textarea></label>
        <label>Choice<select name="choice"><option selected value="SELECT_VALUE_SECRET">SELECT_TEXT_SECRET</option></select></label>
        <input name="duplicate"><input name="duplicate" style="display:none">
        <input name="hidden" type="hidden" value="HIDDEN_VALUE_SECRET">
        <input name="password" type="password" value="PASSWORD_SECRET">
        <button name="submit">Submit</button><a href="/?token=LINK_QUERY_SECRET">Help</a>
        <script>
          localStorage.setItem('fixture', 'STORAGE_SECRET');
          setInterval(async () => {
            if (await (await fetch('/phase')).text() === 'yes') {
              document.querySelector('input[name=first]').id='generated-2';
              document.querySelector('label[for]').htmlFor='generated-2';
            }
          }, 50);
        </script>
      </body></html>`);
      });
      origin = await listen(server);
    });

    afterEach(async () => {
      await scanner?.close();
      scanner = undefined;
      phase = false;
    });
    afterAll(async () => {
      await stop(server);
      await stop(crossOriginServer);
    });

    it("observes metadata without control values, hrefs, storage or query secrets", async () => {
      scanner = await BrowserScanner.open(`${origin}/?token=URL_QUERY_SECRET#FRAGMENT_SECRET`);
      const observation = await scanner.observe();
      expect(observation.trust).toBe("untrusted-page-data");
      const serialized = JSON.stringify(observation);
      expect(serialized).not.toContain("SECRET");
      expect(observation.frames[0]?.url).toBe(`${origin}/`);
      expect(observation.elements.find((e) => e.name === "notes")?.labels[0]?.text).toBe("Notes");
      expect(observation.elements.find((e) => e.name === "choice")?.labels[0]?.text).toBe("Choice");
      expect(observation.elements.find((e) => e.name === "password")?.type).toBe("password");
    });

    it("counts exactly, rejects ambiguity/hidden/non-element/invalid XPath", async () => {
      scanner = await BrowserScanner.open(origin);
      expect((await scanner.verify("//button")).reason).toBe("frame-unproven");
      await scanner.observe();
      expect(await scanner.verify("//button")).toMatchObject({
        count: 1,
        visible: true,
        accepted: true,
      });
      expect(await scanner.verify("//input[@name='duplicate']")).toMatchObject({
        count: 2,
        accepted: false,
        reason: "ambiguous",
      });
      expect(await scanner.verify("//input[@name='hidden']")).toMatchObject({
        count: 1,
        visible: false,
        accepted: false,
      });
      expect((await scanner.verify("//missing")).count).toBe(0);
      expect((await scanner.verify("//input/@value")).accepted).toBe(false);
      expect((await scanner.verify("//body")).reason).toBe("unique-visible");
      expect((await scanner.verify("//input[@name='first']/@id")).reason).toBe(
        "unsupported-target",
      );
      expect((await scanner.verify("//input >> css=button")).reason).toBe("invalid-selector");
      expect((await scanner.verify("count(//input)")).reason).toBe("invalid-selector");
      expect((await scanner.verify("//button", "unknown-frame")).reason).toBe("frame-unproven");
    });

    it("observes main and frame titles plus empty semantic targets without value or body leaks", async () => {
      scanner = await BrowserScanner.open(`${origin}/semantic?token=QUERY_SECRET`);
      const observation = await scanner.observe();
      expect(observation).toMatchObject({ title: "Case intake — observed", titleTruncated: false });
      expect(observation.frames.find((f) => f.id === observation.mainFrameId)).toMatchObject({
        title: observation.title,
        titleTruncated: false,
        proof: "observed-document",
      });
      expect(observation.frames.find((f) => f.parentId === observation.mainFrameId)).toMatchObject({
        title: "Child confirmation",
        titleTruncated: false,
      });
      expect(JSON.stringify(observation)).not.toContain("SECRET");
      expect(observation.elements.find((e) => e.id === "message")?.text).toBe("Ready");
      expect(observation.elements.find((e) => e.tag === "body")?.text).toBe("");
      expect(observation.elements.find((e) => e.type === "password")?.text).toBe("");
      for (const [tag, role, ariaLive] of [
        ["output", "", ""],
        ["span", "status", ""],
        ["div", "", "polite"],
        ["x-notice", "note status", ""],
      ]) {
        expect(observation.elements).toContainEqual(
          expect.objectContaining({ tag, role, ariaLive, text: "" }),
        );
      }
      const output = observation.elements.find(
        (e) => e.tag === "output" && e.frameId === observation.mainFrameId,
      );
      const outputCandidate = output?.candidates.find((c) => c.basis === "tag");
      if (!output || !outputCandidate) throw new Error("Missing empty output candidate");
      expect(outputCandidate).toMatchObject({
        selector: "//output",
        stability: "unproven",
        bpCompatibility: "unproven",
      });
      expect(await scanner.verify(outputCandidate.selector, output.frameId)).toMatchObject({
        count: 1,
        accepted: true,
      });
      const status = observation.elements.find((e) => e.id === "confirmation");
      const roleCandidate = status?.candidates.find((c) => c.basis === "role");
      const idCandidate = status?.candidates.find((c) => c.basis === "id");
      if (!roleCandidate || !idCandidate) throw new Error("Missing status candidates");
      expect(await scanner.verify(roleCandidate.selector)).toMatchObject({
        count: 2,
        reason: "ambiguous",
        accepted: false,
      });
      expect(await scanner.verify(idCandidate.selector)).toMatchObject({
        count: 1,
        accepted: true,
      });
      const live = observation.elements.find((e) => e.tag === "div" && e.ariaLive === "polite");
      const liveCandidate = live?.candidates.find((c) => c.basis === "aria-live");
      if (!liveCandidate) throw new Error("Missing live region candidate");
      expect(await scanner.verify(liveCandidate.selector)).toMatchObject({
        count: 1,
        accepted: true,
      });
      const child = observation.elements.find((e) => e.id === "child-result");
      expect(await scanner.verify("//output", child?.frameId)).toMatchObject({
        count: 1,
        accepted: false,
        reason: "not-visible",
      });
    });

    it("bounds titles and semantic metadata and never uses clipped attributes in selectors", async () => {
      scanner = await BrowserScanner.open(`${origin}/semantic-many`, {
        maxElements: 3,
        maxTextLength: 20,
        maxBytes: 2048,
      });
      const observation = await scanner.observe();
      expect(observation.title).toBe("漢".repeat(20));
      expect(observation.titleTruncated).toBe(true);
      expect(observation.frames[0]?.titleTruncated).toBe(true);
      expect(observation.truncated.elements).toBe(true);
      expect(observation.elements.length).toBeGreaterThan(0);
      expect(observation.elements.length).toBeLessThanOrEqual(3);
      expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(2048);
      for (const element of observation.elements) {
        expect(element.text.length).toBeLessThanOrEqual(20);
        expect(element.truncatedAttributes).toEqual(
          expect.arrayContaining(["role", "ariaLive", "text"]),
        );
        expect(element.candidates.map((c) => c.basis)).not.toContain("role");
        expect(element.candidates.map((c) => c.basis)).not.toContain("aria-live");
      }
      expect(await scanner.verify("//div")).toMatchObject({ count: 80, accepted: false });
    });

    it("bounds UTF-8 title evidence even with no elements to discard", async () => {
      scanner = await BrowserScanner.open(`${origin}/title-budget`, {
        maxTextLength: 500,
        maxBytes: 2048,
      });
      const observation = await scanner.observe();
      expect(observation.title).toBeTruthy();
      expect(observation.titleTruncated).toBe(true);
      expect(observation.truncated.bytes).toBe(true);
      expect(observation.frames[0]?.title).toBe(observation.title);
      expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(2048);
    });

    it("keeps label-for selectors valid across changing IDs without claiming stability", async () => {
      const instance = await BrowserScanner.open(origin);
      scanner = instance;
      const observation = await instance.observe();
      const candidate = observation.elements
        .find((e) => e.name === "first")
        ?.candidates.find((c) => c.basis === "label-for");
      if (!candidate) throw new Error("Missing label candidate");
      expect((await instance.verify(candidate.selector)).accepted).toBe(true);
      phase = true;
      await expect
        .poll(async () => (await instance.verify("//input[@id='generated-2']")).accepted)
        .toBe(true);
      expect((await instance.verify(candidate.selector)).accepted).toBe(true);
      expect(candidate.stability).toBe("unproven");
    });

    it("evaluates a generated label XPath containing both quote types", async () => {
      scanner = await BrowserScanner.open(origin);
      const observation = await scanner.observe();
      const candidate = observation.elements
        .find((e) => e.id === "quoted")
        ?.candidates.find((c) => c.basis === "label-for");
      if (!candidate) throw new Error("Missing quoted label fixture");
      expect((await scanner.verify(candidate.selector)).accepted).toBe(true);
    });

    it("observes real adjacent labels, preserves alternatives and rejects invented adjacency", async () => {
      scanner = await BrowserScanner.open(`${origin}/siblings`);
      const observation = await scanner.observe();
      expect(JSON.stringify(observation)).not.toContain("SIBLING_VALUE_SECRET");
      const adjacent = observation.elements.find((e) => e.id === "adjacent");
      expect(adjacent?.labels.map((label) => label.relation)).toEqual([
        "preceding-adjacent-sibling",
        "for",
      ]);
      expect(adjacent?.candidates.slice(0, 2).map((c) => c.basis)).toEqual([
        "label-sibling",
        "label-for",
      ]);
      if (!adjacent) throw new Error("Missing adjacent label fixture");
      for (const candidate of adjacent.candidates.slice(0, 2)) {
        expect(candidate.bpCompatibility).toBe("unproven");
        expect(await scanner.verify(candidate.selector, adjacent.frameId)).toMatchObject({
          count: 1,
          accepted: true,
        });
      }
      for (const id of ["gap", "nested", "wrapped", "later"]) {
        const element = observation.elements.find((e) => e.id === id);
        expect(element).toBeDefined();
        expect(element?.candidates.map((c) => c.basis)).not.toContain("label-sibling");
      }
      const unassociated = observation.elements.find((e) => e.id === "no-for");
      expect(unassociated?.labels[0]?.relation).toBe("preceding-adjacent-sibling");
      expect(unassociated?.candidates[0]?.basis).toBe("label-sibling");
    });

    it("does not hide sibling XPath ambiguity with a first-match predicate", async () => {
      scanner = await BrowserScanner.open(`${origin}/siblings`);
      const observation = await scanner.observe();
      for (const id of ["dup-a", "earlier"]) {
        const element = observation.elements.find((e) => e.id === id);
        const candidate = element?.candidates[0];
        if (!candidate) throw new Error("Missing ambiguous sibling fixture");
        expect(candidate.basis).toBe("label-sibling");
        expect(candidate.selector).not.toContain("[1]");
        expect(await scanner.verify(candidate.selector, element.frameId)).toMatchObject({
          count: 2,
          accepted: false,
          reason: "ambiguous",
        });
      }
    });

    it("reports frame and DOM scan truncation without proving omitted frames", async () => {
      scanner = await BrowserScanner.open(`${origin}/frames`, { maxFrames: 1, maxDomNodes: 1 });
      const observation = await scanner.observe();
      expect(observation.frames).toHaveLength(1);
      expect(observation.truncated).toMatchObject({ frames: true, dom: true });
      expect(observation.elements).toEqual([]);
      expect((await scanner.verify("//input", "omitted-child")).reason).toBe("frame-unproven");
    });

    it("binds frames by observed identity, handles cross-origin and rejects hidden frames", async () => {
      scanner = await BrowserScanner.open(`${origin}/frames`);
      const observation = await scanner.observe();
      expect(observation.frames).toHaveLength(4);
      expect(JSON.stringify(observation)).not.toContain("SECRET");
      const children = observation.elements.filter((e) => e.name === "child");
      expect(children).toHaveLength(2);
      const results = children.map((e) => e.frameId);
      const visible: boolean[] = [];
      for (const id of results) visible.push((await scanner.verify("//input", id)).accepted);
      expect(visible.sort()).toEqual([false, true]);
      const cross = observation.elements.find((e) => e.id === "cross");
      expect(cross).toBeDefined();
      expect((await scanner.verify("//input", cross?.frameId)).accepted).toBe(true);
      expect((await scanner.verify("//input")).reason).toBe("not-found");
    });

    it("invalidates frame references after navigation and after a new observation", async () => {
      const instance = await BrowserScanner.open(`${origin}/frames`);
      scanner = instance;
      const old = await instance.observe();
      const child = old.elements.find((e) => e.name === "child");
      if (!child) throw new Error("Missing child fixture");
      phase = true;
      await expect
        .poll(async () => (await instance.verify("//input", child.frameId)).reason)
        .toBe("stale-frame");
      await instance.observe();
      expect((await instance.verify("//input", child.frameId)).reason).toBe("frame-unproven");
    });

    it("bounds responses while verification counts all matches", async () => {
      scanner = await BrowserScanner.open(`${origin}/many`, {
        maxElements: 3,
        maxTextLength: 20,
        maxBytes: 2048,
      });
      const observation = await scanner.observe();
      expect(observation.elements.length).toBeLessThanOrEqual(3);
      expect(observation.truncated.elements).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(2048);
      expect(observation.elements.every((e) => e.text.length <= 20)).toBe(true);
      expect(await scanner.verify("//button")).toMatchObject({ count: 80, accepted: false });
    });

    it("closes idempotently and refuses further work", async () => {
      scanner = await BrowserScanner.open(origin);
      await scanner.close();
      await scanner.close();
      await expect(scanner.observe()).rejects.toMatchObject({ code: "CLOSED" });
    });
  },
);
