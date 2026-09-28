"""Spikes S2 + S3: generate a browser-mode object and a test process for RPA Challenge.

S2: does a generated object import cleanly into Blue Prism 7.5.1?
S3: does the personal runtime resource drive Chrome through the extension when the
    test process is started by AutomateC?

Throwaway spike code: the real generator will be built from a typed IR. Writes
two files next to this script; importing/running is done with bp_admin.py.
"""
from __future__ import annotations

import json
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
NS = uuid.UUID("5b1f0c1e-2b8e-4c2a-9a55-7d1f6d8a0b00")
BP_VERSION = "7.5.1.18099"
OBJECT_NAME = "SPIKE - RPA Challenge"
PROCESS_NAME = "SPIKE - RPA Challenge Test"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "https://rpachallenge.com/"


def gid(*parts: str) -> str:
    """Deterministic GUID so regenerating yields identical XML."""
    return str(uuid.uuid5(NS, "/".join(parts)))


def sub(parent: ET.Element, tag: str, text: str | None = None, **attrs: str) -> ET.Element:
    el = ET.SubElement(parent, tag, {k.rstrip("_"): v for k, v in attrs.items()})
    if text is not None:
        el.text = text
    return el


def process_root(name: str, **extra: str) -> ET.Element:
    root = ET.Element("process", {
        "name": name, "version": "1.0", "bpversion": BP_VERSION, "narrative": "Spike S2/S3 - generated",
        "byrefcollection": "true", "preferredid": gid(name), **extra,
    })
    view = sub(root, "view")
    sub(view, "camerax", "0")
    sub(view, "cameray", "0")
    sub(view, "zoom", "1.25", version="2")
    sub(root, "preconditions")
    sub(root, "endpoint", narrative="")
    return root


# --------------------------------------------------------------------------- object

CATALOG = json.loads((HERE / "ami-catalog-browser.json").read_text(encoding="utf-8"))
WEB_IDENTIFIERS = [(i["id"], i["dataType"]) for i in CATALOG["webIdentifiers"]]
EMPTY = {"text": "", "number": "0", "flag": "False"}
# Every argument an action/condition declares must be present in the step, even
# empty (= use the application model default), or the engine throws at run time.
ACTION_ARGS: dict[str, list[str]] = {}
for _et in CATALOG["browserElementTypes"]:
    for _group in ("actions", "readActions", "writeActions", "conditions"):
        for _a in _et[_group]:
            ACTION_ARGS.setdefault(_a["id"], [p["id"] for p in _a["arguments"]])


def add_arguments(parent: ET.Element, action_id: str, values: dict[str, str]) -> None:
    args = sub(parent, "arguments")
    for arg_id in ACTION_ARGS[action_id]:
        arg = sub(args, "argument")
        sub(arg, "id", arg_id)
        sub(arg, "value", values.get(arg_id, ""))


def attribute(attrs: ET.Element, name: str, value: str, datatype: str, inuse: bool) -> None:
    a = sub(attrs, "attribute", name=name)
    if inuse:
        a.set("inuse", "True")
    a.set("isUserVisible", "True")
    sub(a, "ProcessValue", datatype=datatype, value=value)


def web_element(parent: ET.Element, name: str, etype: str, match: dict[str, str],
                extra: dict[str, str] | None = None) -> str:
    """Emit every Web identifier Blue Prism defines, flagging only `match` as in use."""
    eid = gid(OBJECT_NAME, "element", name)
    el = sub(parent, "element", name=name)
    sub(el, "id", eid)
    sub(el, "type", etype)
    sub(el, "basetype", etype)
    sub(el, "datatype", "text")
    sub(el, "diagnose", "False")
    attrs = sub(el, "attributes")
    values = {"wPageAddress": URL, **(extra or {}), **match}
    for ident, datatype in WEB_IDENTIFIERS:
        attribute(attrs, ident, values.get(ident, EMPTY[datatype]), datatype, inuse=ident in match)
    return eid


class Page:
    """Linear page builder: Start -> steps... -> End, with stage ids and layout."""

    def __init__(self, root: ET.Element, owner: str, name: str | None, kind: str = "Normal",
                 inputs: list[str] = (), outputs: list[str] = ()) -> None:
        self.root, self.owner, self.name = root, owner, name
        self.sheet = gid(owner, "sheet", name) if name else None
        self.y = -90
        self.stages: list[ET.Element] = []
        if self.sheet:
            ss = sub(root, "subsheet", subsheetid=self.sheet, type=kind, published="True")
            sub(ss, "name", name)
            v = sub(ss, "view")
            sub(v, "camerax", "0")
            sub(v, "cameray", "0")
            sub(v, "zoom", "1.25", version="2")
            info = self._stage("SubSheetInfo", name, x="-195", y="-105")
            info.find("display").set("w", "150")
            info.find("display").set("h", "90")
        else:
            # Main page carries the ProcessInfo stage; objects also need their code
            # options here, or the engine throws a NullReferenceException at start.
            info = self._stage("ProcessInfo", "Info", x="-195", y="-105")
            info.find("display").set("w", "150")
            info.find("display").set("h", "90")
            if root.get("type") == "object":
                refs = sub(info, "references")
                for r in ("System.dll", "System.Data.dll", "System.Xml.dll", "System.Drawing.dll"):
                    sub(refs, "reference", r)
                imps = sub(info, "imports")
                for i in ("System", "System.Drawing", "System.Data"):
                    sub(imps, "import", i)
                sub(info, "language", "visualbasic")
                sub(info, "pythondllpath", "")
                sub(info, "pythonenvpath", "")
                sub(info, "globalcode")
                sub(info, "code")
        start = self._stage("Start", "Start")
        if inputs:
            ins = sub(start, "inputs")
            for i in inputs:
                sub(ins, "input", type="text", name=i, stage=i)
        self.pending = start
        self.outputs = list(outputs)
        self.data_names = list(inputs) + [o for o in outputs if o not in inputs]

    def _stage(self, stype: str, name: str, x: str = "15", y: str | None = None) -> ET.Element:
        # Stage type is part of the key: a page's info stage shares the page's name, and
        # a stage with the same name must not collide with it (the engine would follow
        # links into the info stage).
        st = ET.Element("stage", stageid=gid(self.owner, str(self.name), stype, name), name=name, type=stype)
        if self.sheet:
            sub(st, "subsheetid", self.sheet)
        if y is None:
            y, self.y = str(self.y), self.y + 60
        sub(st, "display", x=x, y=y)
        self.stages.append(st)
        return st

    def _link(self, st: ET.Element) -> None:
        sub(self.pending, "onsuccess", st.get("stageid"))
        self.pending = st

    def navigate(self, name: str, element_id: str, action: str, args: dict[str, str] = {},
                 outputs: dict[str, str] = {}) -> None:
        st = self._stage("Navigate", name)
        self._link(st)
        step = sub(st, "step")
        sub(step, "element", id=element_id)
        act = sub(step, "action")
        sub(act, "id", action)
        add_arguments(act, action, args)
        if outputs:
            o = sub(act, "outputs")
            for k, v in outputs.items():
                out = sub(o, "output")
                sub(out, "id", k)
                sub(out, "value", v)

    def write(self, name: str, element_id: str, expr: str) -> None:
        st = self._stage("Write", name)
        self._link(st)
        step = sub(st, "step", expr=expr)
        sub(step, "element", id=element_id)
        act = sub(step, "action")
        sub(act, "id", "WebWrite")
        add_arguments(act, "WebWrite", {})

    def read(self, name: str, element_id: str, action: str, into: str) -> None:
        st = self._stage("Read", name)
        self._link(st)
        step = sub(st, "step", stage=into)
        sub(step, "element", id=element_id)
        act = sub(step, "action")
        sub(act, "id", action)
        add_arguments(act, action, {})

    def wait_exists(self, name: str, element_id: str, timeout: int, error: str) -> None:
        group = gid(self.owner, str(self.name), "wait", name)
        wait = self._stage("WaitStart", name)
        self._link(wait)
        sub(wait, "groupid", group)
        choice = sub(sub(wait, "choices"), "choice", reply="True")
        sub(choice, "name", name + " - exists")
        sub(choice, "distance", "60")
        self.choice = choice
        sub(choice, "element", id=element_id)
        cond = sub(choice, "condition")
        sub(cond, "id", "WebCheckExists")
        add_arguments(cond, "WebCheckExists", {})
        sub(choice, "comparetype", "Equal")
        sub(wait, "timeout", str(timeout))
        timeout_stage = self._stage("WaitEnd", name + " - Time Out", x="120", y=str(self.y - 60))
        sub(timeout_stage, "groupid", group)
        exc = self._stage("Exception", name + " - Not Found", x="120", y=str(self.y))
        sub(exc, "exception", localized="yes", type="System Exception", detail=f'"{error}"')
        sub(timeout_stage, "onsuccess", exc.get("stageid"))
        self.pending = choice  # the success path continues from the choice via <ontrue>

    def action(self, name: str, obj: str, action: str, inputs: dict[str, str] = {},
               outputs: dict[str, str] = {}) -> None:
        st = self._stage("Action", name)
        self._link(st)
        # friendlyname is mandatory on Action parameters: without it the engine looks the
        # name up through the object catalogue and throws a NullReferenceException.
        if inputs:
            ins = sub(st, "inputs")
            for k, v in inputs.items():
                sub(ins, "input", type="text", name=k, friendlyname=k, expr=v)
        if outputs:
            outs = sub(st, "outputs")
            for k, v in outputs.items():
                sub(outs, "output", type="text", name=k, friendlyname=k, stage=v)
        sub(st, "resource", object=obj, action=action)

    def end(self) -> None:
        st = self._stage("End", "End")
        if self.outputs:
            outs = sub(st, "outputs")
            for o in self.outputs:
                sub(outs, "output", type="text", name=o, stage=o)
        self._link(st)
        for d in self.data_names:
            data = self._stage("Data", d, x="195", y=str(-90 + 45 * self.data_names.index(d)))
            sub(data, "datatype", "text")
            sub(data, "initialvalue")
            sub(data, "private")
            sub(data, "alwaysinit")
        for st in self.stages:
            self.root.append(st)


def _link_from_choice(page: Page, st: ET.Element) -> None:
    sub(page.pending, "ontrue", st.get("stageid"))
    page.pending = st


def build_object() -> ET.Element:
    root = process_root(OBJECT_NAME, type="object", runmode="Foreground")
    appdef = sub(root, "appdef")
    app = sub(appdef, "element", name="RPA Challenge")
    app_id = gid(OBJECT_NAME, "application")
    sub(app, "id", app_id)
    # The root must be typed as Application: Launch/Close target it, and an untyped
    # root makes the Launch action throw a NullReferenceException.
    sub(app, "type", "Application")
    sub(app, "basetype", "Application")
    sub(app, "datatype", "unknown")
    sub(app, "diagnose", "False")
    start_btn = web_element(app, "Home - Start Button", "WebButton",
                            {"wElementType": "BUTTON", "wCssSelector": "button.btn-large"})
    first_name = web_element(app, "Form - First Name Field", "WebTextEdit",
                             {"wElementType": "INPUT", "wCssSelector": "input[ng-reflect-name='labelFirstName']"})
    info = sub(appdef, "apptypeinfo")
    sub(info, "id", "BrowserLaunch")
    params = sub(info, "parameters")
    # 7.5 BrowserLaunch declares 5 parameters; omitting prelaunchbrowser (new since 7.4)
    # makes the Launch action throw a NullReferenceException.
    # A dedicated profile makes every Launch a fresh, trackable Chrome process that never
    # hands off to (or disturbs) a Chrome the user already has open.
    profile = Path.home() / "AppData" / "Local" / "Temp" / "bp-robot-chrome-profile"
    cmdline = f"{URL} --user-data-dir={profile} --no-first-run --no-default-browser-check"
    for k, v in {"Path": CHROME, "CommandLineParams": cmdline, "prelaunchbrowser": "False",
                 "ProcessMode": "Internal", "ExternalProcessTimeout": "0"}.items():
        p = sub(params, "parameter")
        sub(p, "name", k)
        sub(p, "value", v)

    main = Page(root, OBJECT_NAME, None)
    main.end()
    cleanup = Page(root, OBJECT_NAME, "Clean Up", kind="CleanUp")
    cleanup.end()

    launch = Page(root, OBJECT_NAME, "Launch")
    launch.navigate("Launch Browser", app_id, "Launch", outputs={"trackingid": ""})
    launch.wait_exists("Wait for Home", start_btn, 30, "RPA Challenge home page did not load")
    end = launch._stage("End", "End")
    _link_from_choice(launch, end)
    for st in launch.stages:
        root.append(st)

    diag = Page(root, OBJECT_NAME, "Diagnose", outputs=["Start Text"])
    diag.read("Read Start Text", start_btn, "WebGetText", "Start Text")
    diag.wait_exists("Wait for First Name", first_name, 5, "First Name field not found by its CSS selector")
    diag_end = diag._stage("End", "End")
    outs = sub(diag_end, "outputs")
    sub(outs, "output", type="text", name="Start Text", stage="Start Text")
    _link_from_choice(diag, diag_end)
    data = diag._stage("Data", "Start Text", x="195", y="-90")
    for tag in ("datatype",):
        sub(data, tag, "text")
    sub(data, "initialvalue")
    sub(data, "private")
    sub(data, "alwaysinit")
    for st in diag.stages:
        root.append(st)

    fill = Page(root, OBJECT_NAME, "Write First Name", inputs=["First Name"], outputs=["Value Read Back"])
    fill.write("Write First Name", first_name, "[First Name]")
    fill.read("Read First Name", first_name, "WebGetValue", "Value Read Back")
    fill.end()

    term = Page(root, OBJECT_NAME, "Terminate")
    term.navigate("Close Browser", app_id, "WebCloseApplication", args={"trackingid": ""})
    term.end()
    return root


def build_test_process() -> ET.Element:
    root = process_root(PROCESS_NAME)
    main = Page(root, PROCESS_NAME, None, outputs=["Echo", "Start Text"])
    main.action("Launch", OBJECT_NAME, "Launch")
    main.action("Diagnose", OBJECT_NAME, "Diagnose", outputs={"Start Text": "Start Text"})
    main.action("Write First Name", OBJECT_NAME, "Write First Name",
                inputs={"First Name": '"Claude"'}, outputs={"Value Read Back": "Echo"})
    main.action("Terminate", OBJECT_NAME, "Terminate")
    main.end()

    # Whatever fails, close the browser before surfacing the error, so a failed run
    # never leaves windows or tabs behind: Recover -> Terminate -> Resume -> rethrow.
    def stage(stype: str, name: str, y: int) -> ET.Element:
        st = sub(root, "stage", stageid=gid(PROCESS_NAME, "recovery", stype, name), name=name, type=stype)
        sub(st, "display", x="195", y=str(y))
        return st
    recover = stage("Recover", "On Error", 30)
    close = stage("Action", "Close Browser After Error", 90)
    resume = stage("Resume", "Resume", 150)
    rethrow = stage("Exception", "Rethrow", 210)
    sub(recover, "onsuccess", close.get("stageid"))
    sub(close, "onsuccess", resume.get("stageid"))
    sub(close, "resource", object=OBJECT_NAME, action="Terminate")
    sub(resume, "onsuccess", rethrow.get("stageid"))
    sub(rethrow, "exception", localized="yes", type="", detail="", usecurrent="yes")
    return root


def build_ping_object() -> ET.Element:
    """Bisection helper: an object with no application model and one trivial page."""
    root = process_root("SPIKE - Ping", type="object", runmode="Background")
    app = sub(sub(root, "appdef"), "element", name="Application Root")
    sub(app, "id", gid("SPIKE - Ping", "application"))
    main = Page(root, "SPIKE - Ping", None)
    main.end()
    Page(root, "SPIKE - Ping", "Clean Up", kind="CleanUp").end()
    ping = Page(root, "SPIKE - Ping", "Ping", inputs=["Text"], outputs=["Text"])
    ping.end()
    return root


def build_ping_process() -> ET.Element:
    root = process_root("SPIKE - Ping Test")
    main = Page(root, "SPIKE - Ping Test", None, outputs=["Echo"])
    main.action("Ping", "SPIKE - Ping", "Ping", inputs={"Text": '"pong"'}, outputs={"Text": "Echo"})
    main.end()
    return root


def save(root: ET.Element, filename: str) -> Path:
    ET.indent(root)
    path = HERE / filename
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    return path


if __name__ == "__main__":
    print(save(build_object(), "SPIKE - RPA Challenge.bpobject"))
    print(save(build_test_process(), "SPIKE - RPA Challenge Test.bpprocess"))
    print(save(build_ping_object(), "SPIKE - Ping.bpobject"))
    print(save(build_ping_process(), "SPIKE - Ping Test.bpprocess"))
