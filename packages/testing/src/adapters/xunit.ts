import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { TestCaseResult, TestCommand, TestRunOptions } from "@appforge/core";
import { BaseRunner, REPORT_DIR, writeIfMissing } from "../base.ts";
import { parseTrx } from "../parsers.ts";

export class XunitRunner extends BaseRunner {
  readonly id = "xunit" as const;
  readonly layer = "unit" as const;
  readonly label = "xUnit";

  async scaffold(dir: string) {
    const written: string[] = [];
    if ((await findTestProjects(dir)).length) return { filesWritten: written };
    const apiRef = existsSync(path.join(dir, "Api", "Api.csproj")) ? `\n  <ItemGroup>\n    <ProjectReference Include="..\\Api\\Api.csproj" />\n  </ItemGroup>` : "";
    await writeIfMissing(
      dir,
      "Api.Tests/Api.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="Microsoft.AspNetCore.Mvc.Testing" Version="8.0.11" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="3.0.2" />
  </ItemGroup>${apiRef}
</Project>
`,
      written,
    );
    await writeIfMissing(dir, "Api.Tests/SmokeTests.cs", `namespace Api.Tests;\n\npublic class SmokeTests\n{\n    [Fact]\n    public void Runs() => Assert.True(true);\n}\n`, written);
    return { filesWritten: written, installCommand: "dotnet restore" };
  }

  command(options: Pick<TestRunOptions, "filter">, project = "Api.Tests"): TestCommand {
    const reportPath = `${REPORT_DIR}/xunit`;
    return {
      file: "dotnet",
      args: ["test", project, "--logger", "trx", "--results-directory", reportPath, ...(options.filter ? ["--filter", options.filter] : [])],
      reportPath,
    };
  }

  protected override async resolveCommand(options: TestRunOptions) {
    const projects = await findTestProjects(options.cwd);
    return this.command(options, projects[0] ?? ".");
  }

  protected parseCases(docs: string[]): TestCaseResult[] {
    return parseTrx(docs);
  }
}

/** Folders containing a *Tests.csproj (one level deep). */
async function findTestProjects(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(path.join(dir, entry.name)).catch(() => [] as string[]);
    if (files.some((f) => /tests?\.csproj$/i.test(f))) out.push(entry.name);
  }
  return out.sort();
}
