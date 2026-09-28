// bpprobe apptypes <out.json>: application types (Launch/Attach variants) and the
// parameters each one declares, as Application Modeller would offer them.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Web.Script.Serialization;

internal static class AppTypes
{
    public static string Dump(string bpDir)
    {
        var appMan = Assembly.LoadFrom(Path.Combine(bpDir, "BluePrism.AppMan.dll"));
        appMan.GetType("BluePrism.AppMan.ContainerInitialiser", true).GetMethod("SetUpContainer").Invoke(null, null);
        var ami = Assembly.LoadFrom(Path.Combine(bpDir, "AMI.dll"));
        var ati = ami.GetType("BluePrism.ApplicationManager.AMI.ApplicationTypeInfo", true);
        var getTypes = ati.GetMethod("GetApplicationTypes", BindingFlags.Public | BindingFlags.Static);
        var globalInfoType = getTypes.GetParameters()[0].ParameterType;
        var globalInfo = globalInfoType.GetConstructor(Type.EmptyTypes)?.Invoke(null);
        var roots = (IEnumerable)getTypes.Invoke(null, new[] { globalInfo });
        var result = roots.Cast<object>().Select(Describe).ToList();
        return new JavaScriptSerializer { MaxJsonLength = int.MaxValue }.Serialize(result);
    }

    private static Dictionary<string, object> Describe(object appType)
    {
        var d = Scalars(appType);
        if (appType.GetType().GetProperty("Parameters")?.GetValue(appType, null) is IEnumerable ps)
            d["parameters"] = ps.Cast<object>().Select(Scalars).ToList();
        if (appType.GetType().GetProperty("SubTypes")?.GetValue(appType, null) is IEnumerable subs)
            d["subTypes"] = subs.Cast<object>().Select(Describe).ToList();
        return d;
    }

    // Every public readable property or field whose value is a string, number, bool or enum.
    private static Dictionary<string, object> Scalars(object o)
    {
        var d = new Dictionary<string, object>();
        var t = o.GetType();
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (p.GetIndexParameters().Length > 0) continue;
            try { Put(d, p.Name, p.GetValue(o, null)); } catch { }
        }
        foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance))
            Put(d, f.Name, f.GetValue(o));
        return d;
    }

    private static void Put(Dictionary<string, object> d, string name, object v)
    {
        if (v == null || v is string || v is bool || v.GetType().IsPrimitive) d[name] = v;
        else if (v.GetType().IsEnum) d[name] = v.ToString();
    }
}
