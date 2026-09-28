// bpprobe validate <file>: load a process/object XML with Blue Prism's own parser
// (BluePrismProcess.FromXmlThrowsErrors) and report what it sees or where it breaks.
using System;
using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;

internal static class Validate
{
    public static int Run(string bpDir, string file)
    {
        var startUp = Assembly.LoadFrom(Path.Combine(bpDir, "BluePrism.StartUp.dll"));
        startUp.GetType("BluePrism.StartUp.ContainerInitialiser", true).GetMethod("SetUpContainer").Invoke(null, null);

        var core = Assembly.LoadFrom(Path.Combine(bpDir, "AutomateProcessCore.dll"));
        var bpProcess = core.GetType("BluePrism.AutomateProcessCore.BluePrismProcess", true);
        var load = bpProcess.GetMethods(BindingFlags.Public | BindingFlags.Static)
            .First(m => m.Name == "FromXmlThrowsErrors" && m.GetParameters().Length == 3);
        // Action stages resolve their parameters against the external object catalogue;
        // an empty catalogue is enough to check that the XML itself parses.
        var appCore = Assembly.LoadFrom(Path.Combine(bpDir, "AutomateAppCore.dll"));
        var emptyObjects = appCore.GetType("BluePrism.AutomateAppCore.clsGroupObjectDetails", true)
            .GetProperty("Empty", BindingFlags.Public | BindingFlags.Static).GetValue(null, null);
        var xml = File.ReadAllText(file);
        object process;
        try
        {
            process = load.Invoke(null, new object[] { emptyObjects, xml, false });
        }
        catch (TargetInvocationException ex)
        {
            Console.WriteLine("INVALID: " + ex.InnerException);
            return 1;
        }

        var stages = (IEnumerable)Get(process, "GetStages") ?? Enumerable.Empty<object>();
        var stageList = stages.Cast<object>().ToList();
        Console.WriteLine($"OK: name={Get(process, "Name")} type={Get(process, "ProcessType")} stages={stageList.Count}");
        foreach (var group in stageList.GroupBy(s => Get(s, "StageType")?.ToString()).OrderBy(g => g.Key))
            Console.WriteLine($"  {group.Key}: {group.Count()}");
        // Application stages (Read/Write/Navigate/Wait): show what the parser really kept.
        foreach (var s in stageList.Where(s => Get(s, "Steps") is IEnumerable || Get(s, "Choices") is IEnumerable))
        {
            var steps = (Get(s, "Steps") as IEnumerable ?? Get(s, "Choices") as IEnumerable).Cast<object>().ToList();
            Console.WriteLine($"  [{s.GetType().Name}] {Get(s, "Name")}: {steps.Count} step(s)");
            foreach (var step in steps)
            {
                var action = Get(step, "Action") ?? Get(step, "Condition");
                var expr = Get(step, "Expression");
                Console.WriteLine($"      element={Get(step, "ElementId")} action={(action == null ? "null" : Get(action, "ID"))} expr={(expr == null ? "" : Get(expr, "NormalForm") ?? expr)}");
                if (Get(s, "Choices") is IEnumerable)
                    Console.WriteLine($"        choice distance={Get(step, "Distance")} location={Get(step, "Location")}");
                foreach (var parameter in (Get(step, "Parameters") as IEnumerable ?? Enumerable.Empty<object>()))
                {
                    var value = Get(parameter, "Expression");
                    Console.WriteLine($"        dynamic {Get(parameter, "Name")}={(value == null ? "" : Get(value, "NormalForm") ?? value)} type={Get(parameter, "DataType")} comparison={Get(parameter, "ComparisonType")}");
                }
            }
        }
        return 0;
    }

    private static object Get(object o, string member)
    {
        var t = o.GetType();
        var p = t.GetProperty(member, BindingFlags.Public | BindingFlags.Instance);
        if (p != null) return p.GetValue(o, null);
        var m = t.GetMethods(BindingFlags.Public | BindingFlags.Instance)
            .FirstOrDefault(x => x.Name == member && x.GetParameters().Length == 0);
        return m?.Invoke(o, null);
    }
}
