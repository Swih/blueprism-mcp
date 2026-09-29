// Offline native parsing and expression validation; never executes a BP stage/session.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Xml;

internal static class Validate
{
    private const int MaxFileBytes = 4 * 1024 * 1024;
    private const int MaxDiagnostics = 20;
    private static readonly HashSet<string> SupportedStages = new HashSet<string>(
        new[] { "Action", "Anchor", "Block", "Calculation", "Collection", "Data", "Decision",
            "End", "Exception", "Navigate", "ProcessInfo", "Read", "Recover", "Resume",
            "Start", "SubSheet", "SubSheetInfo", "WaitEnd", "WaitStart", "Write" });

    public static int Run(string bpDir, string file)
    {
        var stdout = Console.Out;
        var stderr = Console.Error;
        var diagnostics = new List<string>();
        string summary;
        var exitCode = 1;
        // Native diagnostics may echo expressions or credentials. Publish only fixed codes.
        Console.SetOut(TextWriter.Null);
        Console.SetError(TextWriter.Null);
        try { summary = Check(bpDir, file, diagnostics, out exitCode); }
        catch (Exception) { summary = "INVALID: offline native validation unavailable or input rejected."; }
        finally { Console.SetOut(stdout); Console.SetError(stderr); }
        stdout.WriteLine(summary);
        foreach (var diagnostic in diagnostics) stdout.WriteLine(diagnostic);
        return exitCode;
    }

    private static string Check(string bpDir, string file, List<string> diagnostics, out int exitCode)
    {
        exitCode = 1;
        string xml;
        using (var stream = File.OpenRead(file))
        {
            if (stream.Length > MaxFileBytes) return "INVALID: input byte limit exceeded.";
            using (var reader = new StreamReader(stream)) xml = reader.ReadToEnd();
        }
        var document = new XmlDocument { XmlResolver = null };
        using (var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings {
            DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaxFileBytes
        })) document.Load(reader);
        if (document.DocumentElement?.Name != "process") return "INVALID: expected a process or object.";
        var xmlStages = document.DocumentElement.SelectNodes("stage").Cast<XmlElement>().ToList();
        if (xmlStages.Count > 5000) return "INVALID: stage limit exceeded.";

        var startUp = Assembly.LoadFrom(Path.Combine(bpDir, "BluePrism.StartUp.dll"));
        startUp.GetType("BluePrism.StartUp.ContainerInitialiser", true).GetMethod("SetUpContainer").Invoke(null, null);
        var core = Assembly.LoadFrom(Path.Combine(bpDir, "AutomateProcessCore.dll"));
        var load = core.GetType("BluePrism.AutomateProcessCore.BluePrismProcess", true)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == "FromXmlThrowsErrors" && m.GetParameters().Length == 3);
        var appCore = Assembly.LoadFrom(Path.Combine(bpDir, "AutomateAppCore.dll"));
        // Studio registers this environment function separately from the core functions.
        // Register its native signature with no server provider; justValidate never invokes it.
        var stopType = appCore.GetType("BluePrism.AutomateAppCore.EnvironmentFunctions.IsStopRequestedFunction", true);
        var stop = stopType.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
            .Single(c => c.GetParameters().Length == 1).Invoke(new object[] { null });
        core.GetType("BluePrism.AutomateProcessCore.APC", true).GetMethod("AddFunction")
            .Invoke(null, new[] { stop });
        var emptyObjects = appCore.GetType("BluePrism.AutomateAppCore.clsGroupObjectDetails", true)
            .GetProperty("Empty", BindingFlags.Public | BindingFlags.Static).GetValue(null, null);
        var process = load.Invoke(null, new object[] { emptyObjects, xml, false });
        var stageList = ((IEnumerable)Get(process, "GetStages")).Cast<object>().ToList();
        var nativeStages = stageList.ToDictionary(s => (Guid)Get(s, "Id"));
        var evaluate = core.GetType("BluePrism.AutomateProcessCore.Expression", true)
            .GetMethods(BindingFlags.Public | BindingFlags.Static)
            .Single(m => m.Name == "EvaluateExpression" && m.GetParameters().Length == 6
                && m.GetParameters()[0].ParameterType == typeof(string));
        var errors = 0;
        var unsupported = 0;
        var checkedCount = 0;
        var omitted = 0;
        for (var stageIndex = 0; stageIndex < xmlStages.Count; stageIndex++)
        {
            var element = xmlStages[stageIndex];
            object scope;
            Guid id;
            if (!Guid.TryParse(element.GetAttribute("stageid"), out id) || !nativeStages.TryGetValue(id, out scope))
            {
                errors++;
                Add(diagnostics, stageIndex, 0, "MISSING_NATIVE_STAGE");
                continue;
            }
            if (!SupportedStages.Contains(element.GetAttribute("type"))
                || element.SelectNodes("code|globalcode").Cast<XmlNode>().Any(n => !string.IsNullOrWhiteSpace(n.InnerText)))
            {
                unsupported++;
                Add(diagnostics, stageIndex, 0, "UNSUPPORTED_STAGE_OR_CODE");
            }
            // Generator expression slots; app-model literals and output destinations are not expressions.
            var expressions = element.SelectNodes(".//@expression | .//@expr | ./exception/@detail"
                + " | ./timeout | .//elementparameter/expression | .//argument/value");
            for (var slot = 0; slot < expressions.Count; slot++)
            {
                var node = expressions[slot];
                var owner = node is XmlAttribute ? ((XmlAttribute)node).OwnerElement : node.ParentNode;
                var expression = node is XmlAttribute ? node.Value : node.InnerText;
                if (string.IsNullOrWhiteSpace(expression)
                    && (owner.Name == "input" || owner.Name == "argument"
                        || (owner.Name == "exception" && ((XmlElement)owner).HasAttribute("usecurrent"))))
                {
                    omitted++;
                    continue;
                }
                if (++checkedCount > 10000) return "INVALID: expression count limit exceeded.";
                if (expression.Length > 16384)
                {
                    errors++;
                    Add(diagnostics, stageIndex, slot, "EXPRESSION_LENGTH_LIMIT");
                    continue;
                }
                // ALWAYS justValidate=true: no stage execution, runtime values or sessions.
                var args = new object[] { expression, null, scope, true, null, "" };
                try
                {
                    if (!(bool)evaluate.Invoke(null, args))
                    {
                        errors++;
                        Add(diagnostics, stageIndex, slot, "INVALID_EXPRESSION");
                        continue;
                    }
                    var undefined = Get(args[4], "UndefinedCollectionFields") as IDictionary;
                    if (undefined != null && undefined.Count != 0)
                    {
                        unsupported++;
                        Add(diagnostics, stageIndex, slot, "UNRESOLVED_COLLECTION_SCHEMA");
                    }
                    var resultType = Get(args[1], "DataType")?.ToString();
                    // Wait choices compare a typed expected value (often text), not a flag.
                    if ((owner.Name == "decision" && resultType != "flag")
                        || (node.Name == "timeout" && resultType != "number"))
                    {
                        errors++;
                        Add(diagnostics, stageIndex, slot, "INVALID_CONDITION_OR_TIMEOUT_TYPE");
                    }
                }
                catch (Exception)
                {
                    unsupported++;
                    Add(diagnostics, stageIndex, slot, "NATIVE_EXPRESSION_CHECK_UNAVAILABLE");
                }
            }
        }
        if (errors != 0 || unsupported != 0)
            return $"INVALID: offline expressions rejected; checked={checkedCount} errors={errors} unsupported={unsupported}; diagnostics limited to {MaxDiagnostics}.";
        // Bind identity to what BP actually loaded, never to a raw XML attribute or name echo.
        var nativeName = Get(process, "Name") as string;
        var kind = Get(process, "ProcessType")?.ToString();
        if (nativeName == null || (kind != "Object" && kind != "Process"))
            return "INVALID: native identity unavailable.";
        string nameHash;
        using (var sha = SHA256.Create())
            nameHash = string.Concat(sha.ComputeHash(Encoding.UTF8.GetBytes(nativeName)).Select(b => b.ToString("x2")));
        exitCode = 0;
        diagnostics.Add($"Offline expressions: checked={checkedCount} optional-empty={omitted} unsupported=0. Not full Studio/dependency/runtime validation.");
        return $"OK: name-sha256={nameHash} type={kind} stages={stageList.Count}";
    }

    private static void Add(List<string> diagnostics, int stage, int slot, string code)
    {
        if (diagnostics.Count < MaxDiagnostics)
            diagnostics.Add($"  stage-index={stage} expression-slot={slot} code={code}");
    }

    private static object Get(object o, string member)
    {
        if (o == null) return null;
        var t = o.GetType();
        var p = t.GetProperty(member, BindingFlags.Public | BindingFlags.Instance);
        if (p != null) return p.GetValue(o, null);
        var m = t.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(x => x.Name == member && x.GetParameters().Length == 0);
        return m?.Invoke(o, null);
    }
}
