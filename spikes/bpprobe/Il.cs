// bpprobe il <dll> <type-regex> [method-regex]: crude IL listing of the string literals
// and methods called by each matching method, enough to follow Blue Prism's logic.
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Text.RegularExpressions;

internal static class Il
{
    private static readonly OpCode[] OneByte = new OpCode[0x100];
    private static readonly OpCode[] TwoByte = new OpCode[0x100];

    static Il()
    {
        foreach (var f in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
        {
            var op = (OpCode)f.GetValue(null);
            var v = (ushort)op.Value;
            if (v < 0x100) OneByte[v] = op; else if ((v & 0xff00) == 0xfe00) TwoByte[v & 0xff] = op;
        }
    }

    public static int Run(string bpDir, string dll, string typePattern, string methodPattern)
    {
        var asm = Assembly.LoadFrom(Path.Combine(bpDir, dll));
        Type[] types;
        try { types = asm.GetTypes(); } catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
        var tre = new Regex(typePattern);
        var mre = new Regex(methodPattern ?? ".");
        const BindingFlags all = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
        foreach (var t in types.Where(t => tre.IsMatch(t.FullName ?? "")))
            foreach (var m in t.GetMethods(all).Cast<MethodBase>().Concat(t.GetConstructors(all)).Where(m => mre.IsMatch(m.Name)))
                Dump(t, m);
        return 0;
    }

    private static void Dump(Type t, MethodBase m)
    {
        var body = m.GetMethodBody();
        if (body == null) return;
        Console.WriteLine($"== {t.FullName}::{m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name))})");
        var il = body.GetILAsByteArray();
        var i = 0;
        while (i < il.Length)
        {
            OpCode op;
            if (il[i] == 0xfe) { op = TwoByte[il[i + 1]]; i += 2; } else { op = OneByte[il[i]]; i += 1; }
            var size = OperandSize(op, il, i);
            if (op.OperandType == OperandType.InlineString)
                Console.WriteLine($"   ldstr \"{Safe(() => m.Module.ResolveString(BitConverter.ToInt32(il, i)))}\"");
            else if (op.OperandType == OperandType.InlineMethod)
                Console.WriteLine($"   {op.Name} {Safe(() => { var c = m.Module.ResolveMethod(BitConverter.ToInt32(il, i)); return c.DeclaringType?.Name + "::" + c.Name; })}");
            else if (op == OpCodes.Throw)
                Console.WriteLine("   throw");
            i += size;
        }
    }

    private static int OperandSize(OpCode op, byte[] il, int i)
    {
        switch (op.OperandType)
        {
            case OperandType.InlineNone: return 0;
            case OperandType.ShortInlineBrTarget: case OperandType.ShortInlineI: case OperandType.ShortInlineVar: return 1;
            case OperandType.InlineVar: return 2;
            case OperandType.InlineI8: case OperandType.InlineR: return 8;
            case OperandType.InlineSwitch: return 4 + BitConverter.ToInt32(il, i) * 4;
            default: return 4;
        }
    }

    private static string Safe(Func<string> f) { try { return f(); } catch { return "?"; } }
}
