// bpprobe find <dll> <regex>: list public members whose type or member name matches.
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;

internal static class Find
{
    public static int Run(string bpDir, string dll, string pattern)
    {
        var asm = Assembly.LoadFrom(Path.Combine(bpDir, dll));
        Type[] types;
        try { types = asm.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
        var re = new Regex(pattern, RegexOptions.IgnoreCase);
        foreach (var t in types.OrderBy(t => t.FullName))
        {
            MethodInfo[] methods;
            try { methods = t.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly); }
            catch { continue; }
            var typeMatch = re.IsMatch(t.FullName ?? "");
            foreach (var m in methods.Where(m => typeMatch || re.IsMatch(m.Name)))
            {
                string sig;
                try { sig = string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name + " " + p.Name)); }
                catch { sig = "?"; }
                Console.WriteLine($"{t.FullName}::{(m.IsStatic ? "static " : "")}{m.ReturnType.Name} {m.Name}({sig})");
            }
        }
        return 0;
    }
}
