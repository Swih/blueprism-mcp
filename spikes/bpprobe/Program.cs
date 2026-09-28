// bpprobe: read-only inspection of an installed Blue Prism, through its own assemblies.
//   bpprobe catalog <out.json>        browser-mode catalogue from AMI.dll
//   bpprobe find <dll> <regex>        list public members matching a pattern
//   bpprobe validate <file.xml>       parse a process/object with Blue Prism's own loader
// Build with Blue Prism's bundled Roslyn: see build.ps1.
using System;
using System.IO;
using System.Reflection;

internal static class Program
{
    public const string DefaultBpDir = @"C:\Program Files\Blue Prism Limited\Blue Prism Automate";

    private static int Main(string[] args)
    {
        var bpDir = Environment.GetEnvironmentVariable("BP_INSTALL_DIR") ?? DefaultBpDir;
        AppDomain.CurrentDomain.AssemblyResolve += (s, e) =>
        {
            var path = Path.Combine(bpDir, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(path) ? Assembly.LoadFrom(path) : null;
        };
        // Resolve user paths before switching to the Blue Prism directory (its loaders
        // expect it as the working directory).
        var fileArg = args.Length > 1 ? Path.GetFullPath(args[1]) : null;
        Directory.SetCurrentDirectory(bpDir);
        try
        {
            switch (args.Length > 0 ? args[0] : "")
            {
                case "catalog":
                    File.WriteAllText(fileArg, Catalog.Dump(bpDir), new System.Text.UTF8Encoding(false));
                    Console.WriteLine("Wrote " + fileArg);
                    return 0;
                case "apptypes":
                    File.WriteAllText(fileArg, AppTypes.Dump(bpDir), new System.Text.UTF8Encoding(false));
                    Console.WriteLine("Wrote " + fileArg);
                    return 0;
                case "find":
                    return Find.Run(bpDir, args[1], args[2]);
                case "il":
                    return Il.Run(bpDir, args[1], args[2], args.Length > 3 ? args[3] : null);
                case "validate":
                    return Validate.Run(bpDir, fileArg);
                default:
                    Console.Error.WriteLine("usage: bpprobe catalog <out.json> | find <dll> <regex> | validate <file>");
                    return 2;
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex);
            return 1;
        }
    }
}
