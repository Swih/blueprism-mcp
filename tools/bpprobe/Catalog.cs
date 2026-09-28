// bpprobe catalog: dump the Application Manager catalogue for browser-mode
// applications (element types, actions, reads, writes, wait conditions) from AMI.dll.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Web.Script.Serialization;
using System.Xml;

internal static class Catalog
{
    public static string Dump(string bpDir)
    {
        var appMan = Assembly.LoadFrom(Path.Combine(bpDir, "BluePrism.AppMan.dll"));
        appMan.GetType("BluePrism.AppMan.ContainerInitialiser", true)
              .GetMethod("SetUpContainer").Invoke(null, null);

        var ami = Assembly.LoadFrom(Path.Combine(bpDir, "AMI.dll"));
        var clsAMI = ami.GetType("BluePrism.AMI.clsAMI", true);
        var appTypeInfo = ami.GetType("BluePrism.ApplicationManager.AMI.ApplicationTypeInfo", true);

        var fromXml = appTypeInfo.GetMethods().First(m => m.Name == "FromXML" && m.IsStatic);
        var browserApp = BrowserApplication(fromXml, "BrowserLaunch");
        var browserAttach = BrowserApplication(fromXml, "BrowserAttach");

        var raw = Static(clsAMI, "GetElementTypes");
        var elementTypes = (raw is IDictionary dict ? dict.Values : (IEnumerable)raw).Cast<object>().ToList();
        Console.WriteLine($"GetElementTypes -> {raw.GetType().Name}, {elementTypes.Count} items of {elementTypes.FirstOrDefault()?.GetType().FullName}");
        var result = new Dictionary<string, object>
        {
            ["source"] = "AMI.dll " + System.Diagnostics.FileVersionInfo.GetVersionInfo(Path.Combine(bpDir, "AMI.dll")).FileVersion,
            ["appTypes"] = elementTypes.Select(t => Prop(t, "AppType").ToString()).Distinct().OrderBy(x => x).ToList(),
        };

        var browser = new List<object>();
        foreach (var et in elementTypes.Where(t => new[] { "Web", "Application" }.Contains((string)Prop(t, "AppType"))))
        {
            browser.Add(ElementInfo(clsAMI, et, browserApp));
        }
        result["browserElementTypes"] = browser;
        // Root operations depend on application mode: BrowserAttach uses IsConnected,
        // whereas BrowserLaunch uses WebIsConnected. Never derive one from the other.
        var application = elementTypes.Single(t => (string)Prop(t, "ID") == "Application");
        result["browserAttachApplication"] = ElementInfo(clsAMI, application, browserAttach);

        // Identifiers (element attributes) the Web app type defines, in Blue Prism's order.
        var grouped = Static(clsAMI, "get_ApplicationGroupedIdentifiers");
        var byAppTypes = grouped.GetType().GetMethod("GetByAppTypes");
        var webAppType = Enum.Parse(byAppTypes.GetParameters()[0].ParameterType, "Web");
        result["webIdentifiers"] = Items(byAppTypes.Invoke(grouped, new[] { webAppType }))
            .Select(i => new Dictionary<string, object>
            {
                ["id"] = Prop(i, "IdName"),
                ["name"] = Prop(i, "Name"),
                ["dataType"] = Prop(i, "DataType"),
                ["enableByDefault"] = Prop(i, "EnableByDefault"),
                ["comparison"] = Prop(i, "ComparisonType"),
                ["userVisible"] = Prop(i, "IsUserVisible"),
            }).ToList();
        return new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(result);
    }

    private static object BrowserApplication(MethodInfo fromXml, string kind)
    {
        var doc = new XmlDocument();
        doc.LoadXml("<apptypeinfo><id>" + kind + "</id><parameters /></apptypeinfo>");
        return fromXml.Invoke(null, new object[] { doc.DocumentElement });
    }

    private static Dictionary<string, object> ElementInfo(Type ami, object element, object application) =>
        new Dictionary<string, object>
        {
            ["id"] = Prop(element, "ID"),
            ["appType"] = Prop(element, "AppType"),
            ["name"] = Prop(element, "Name"),
            ["defaultDataType"] = Prop(element, "DefaultDataType"),
            ["help"] = Prop(element, "HelpText"),
            ["actions"] = Items(Static(ami, "GetAllowedActions", element, application)).Select(ActionInfo).ToList(),
            ["readActions"] = Items(Static(ami, "GetAllowedReadActions", element, application)).Select(ActionInfo).ToList(),
            ["writeActions"] = Items(Static(ami, "GetAllowedWriteAction", element)).Select(ActionInfo).ToList(),
            ["conditions"] = Items(Static(ami, "GetAllowedConditions", element, application)).Select(ConditionInfo).ToList(),
        };

    private static Dictionary<string, object> ActionInfo(object a) => new Dictionary<string, object>
    {
        ["id"] = Prop(a, "ID"),
        ["name"] = Prop(a, "Name"),
        ["returns"] = Prop(a, "ReturnType"),
        ["requiresFocus"] = Prop(a, "RequiresFocus"),
        ["arguments"] = Params(Prop(a, "Arguments")),
        ["outputs"] = Params(Prop(a, "Outputs")),
        ["help"] = Prop(a, "HelpText"),
    };

    private static Dictionary<string, object> ConditionInfo(object c) => new Dictionary<string, object>
    {
        ["id"] = Prop(c, "ID"),
        ["name"] = Prop(c, "Name"),
        ["dataType"] = Prop(c, "DataType"),
        ["default"] = Prop(c, "DefaultValue"),
        ["arguments"] = Params(Prop(c, "Arguments")),
        ["help"] = Prop(c, "HelpText"),
    };

    private static List<object> Params(object dict)
    {
        var list = new List<object>();
        if (dict == null) return list;
        var values = dict is IDictionary d ? d.Values : dict.GetType().GetProperty("Values")?.GetValue(dict, null) as IEnumerable;
        if (values == null) return list;
        foreach (var p in values)
            list.Add(new Dictionary<string, object>
            {
                ["id"] = Prop(p, "ID"),
                ["name"] = Prop(p, "Name"),
                ["dataType"] = Prop(p, "DataType"),
                ["help"] = Prop(p, "HelpText"),
            });
        return list;
    }

    private static IEnumerable<object> Items(object o) =>
        o is IEnumerable e && !(o is string) ? e.Cast<object>() : (o == null ? Enumerable.Empty<object>() : new[] { o });

    private static object Prop(object o, string name)
    {
        var value = o.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.Instance)?.GetValue(o, null);
        var keepAsObject = value is bool || (value != null && value.GetType().GetProperty("Values") != null);
        return keepAsObject ? value : value?.ToString();
    }

    private static object Static(Type t, string name, params object[] args) =>
        t.GetMethods(BindingFlags.Public | BindingFlags.Static)
         .First(m => m.Name == name && m.GetParameters().Length == args.Length)
         .Invoke(null, args);
}
