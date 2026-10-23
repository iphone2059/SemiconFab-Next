"""Create missing scaffold files; never overwrite existing source."""
import csv
import json
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT.parent / "SemiconFab-Next-Engineering-v1.1"
projects = {}


def put(path, content):
    path = ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text(content, encoding="utf-8", newline="\n")


def project(folder, name, references=(), framework=False):
    path = f"{folder}/{name}/{name}.csproj"
    projects[name] = path
    refs = "".join(f'    <ProjectReference Include="{Path(__import__("os").path.relpath(ROOT / projects[r], (ROOT / path).parent)).as_posix()}" />\n' for r in references)
    body = f'  <ItemGroup>\n{refs}  </ItemGroup>\n' if refs else ""
    if framework:
        body += '  <ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App" /></ItemGroup>\n'
    put(path, f'<Project Sdk="Microsoft.NET.Sdk">\n{body}</Project>\n')


project("src/Foundation", "Fab.Ids")
project("src/Foundation", "Fab.Contracts", ["Fab.Ids"])
for name in ["Fab.Messaging", "Fab.Observability", "Fab.Hosting", "Fab.Configuration"]:
    project("src/Foundation", name, ["Fab.Contracts"], framework=True)
for context in ["Site", "Manufacturing", "ProcessEngineering", "Equipment", "MaterialHandling", "Maintenance", "Quality", "SiteResources", "Orchestration", "Experiment", "Analytics", "Identity"]:
    project(f"src/{context}", f"Fab.{context}.Domain", ["Fab.Ids"])
    project(f"src/{context}", f"Fab.{context}.Application", [f"Fab.{context}.Domain", "Fab.Contracts"], framework=True)
    project(f"src/{context}", f"Fab.{context}.Infrastructure", [f"Fab.{context}.Application", f"Fab.{context}.Domain"], framework=True)
project("src/Optimization", "Fab.Optimization.Abstractions", ["Fab.Ids"])
project("src/Simulation", "Fab.Simulation.Core", ["Fab.Ids"])
project("src/Simulation", "Fab.Simulation.Models", ["Fab.Simulation.Core", "Fab.Optimization.Abstractions"])
project("src/Simulation", "Fab.Simulation.Runtime", ["Fab.Simulation.Core", "Fab.Simulation.Models", "Fab.Contracts"])
project("src/Simulation", "Fab.Simulation.SiteCoordinator", ["Fab.Simulation.Runtime", "Fab.SiteResources.Domain"])
project("src/Simulation", "Fab.Simulation.NativeBridge", ["Fab.Simulation.Core"])
project("src/IndustrialProfiles", "Fab.IndustrialProfiles", ["Fab.Ids"])
project("src/Security", "Fab.SecurityPolicies", ["Fab.Ids"])
project("src/Eap", "Fab.Eap.Domain", ["Fab.Ids"])
project("src/Eap", "Fab.Eap.Application", ["Fab.Eap.Domain", "Fab.Contracts"])
project("src/Eap", "Fab.Eap.Simulator", ["Fab.Eap.Application", "Fab.IndustrialProfiles", "Fab.Simulation.Models"])
project("src/IndustrialInterfaces", "Fab.IndustrialInterfaces.Domain", ["Fab.Ids"])
project("src/IndustrialInterfaces", "Fab.IndustrialInterfaces.Application", ["Fab.IndustrialInterfaces.Domain", "Fab.Contracts"])
for suffix in ["Protocols", "Adapters"]:
    project("src/IndustrialInterfaces", f"Fab.IndustrialInterfaces.{suffix}", ["Fab.IndustrialInterfaces.Application", "Fab.IndustrialProfiles"])
project("src/Adapters", "Fab.Contracts.Adapters", ["Fab.Contracts"])

for host in ["Fab.Api", "Fab.Worker", "Fab.RealtimeHost", "Fab.OtGateway"]:
    sdk = "Microsoft.NET.Sdk.Web" if host == "Fab.Api" else "Microsoft.NET.Sdk"
    framework = '' if host == "Fab.Api" else '<FrameworkReference Include="Microsoft.AspNetCore.App" />'
    put(f"apps/{host}/{host}.csproj", f'<Project Sdk="{sdk}"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup><ItemGroup>{framework}<ProjectReference Include="../../src/Foundation/Fab.Contracts/Fab.Contracts.csproj" /></ItemGroup></Project>\n')
    projects[host] = f"apps/{host}/{host}.csproj"

for name in ["Fab.Simulation.Tests", "Fab.Orchestration.Tests"]:
    put(f"tests/Unit/{name}/{name}.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><IsTestProject>true</IsTestProject><IsPackable>false</IsPackable></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk"/><PackageReference Include="xunit"/><PackageReference Include="xunit.runner.visualstudio" PrivateAssets="all"/></ItemGroup></Project>\n')
    projects[name] = f"tests/Unit/{name}/{name}.csproj"

for folder in ["contracts/protobuf", "contracts/openapi", "contracts/json-schema", "native/Fab.Native", "assets", "tests/Contracts", "tests/SimulationGolden", "tests/SharedResources", "tests/OTConformance", "tests/E2E", "tests/Performance", "tests/GPUAcceptance", "infrastructure/deployment", "infrastructure/postgresql", "scripts"]:
    put(f"{folder}/README.md", "# " + folder + "\n\n工程边界已预留；功能与验证状态见 `docs/IMPLEMENTATION-STATUS.md`。\n")

rows = list(csv.DictReader((SPEC / "engineering/MODULE-MATRIX.csv").open(encoding="utf-8-sig")))
for row in rows:
    put(f'docs/modules/{row["id"]}.md', f'# {row["id"]} — {row["name"]}\n\nOwner: {row["owner"]}\n\n项目/包：{row["projects"]}\n\n规范：`../../../SemiconFab-Next-Engineering-v1.1/engineering/modules/` 对应模块。\n\n本次初始化仅代表工程边界已建立。具体实现状态见 `../IMPLEMENTATION-STATUS.md`。\n')
for name, path in projects.items():
    put(str(Path(path).parent / "README.md"), f"# {name}\n\n职责按 v1.1 对应模块规范划分。当前功能状态见 `docs/IMPLEMENTATION-STATUS.md`；空项目不代表功能已实现。\n")

solution = ET.Element("Solution")
for path in projects.values():
    ET.SubElement(solution, "Project", Path=path)
ET.indent(solution)
put("SemiconFab.slnx", ET.tostring(solution, encoding="unicode") + "\n")
put("docs/IMPLEMENTATION-STATUS.md", "# 实施状态\n\n首切片：框架、独立仿真、本地开发编排、React/WebGPU。其余能力待实现；本地文件适配器仅限 Development，不能声明 PostgreSQL/工业协议/共享容量已验收。\n")
print(f"Initialized {len(projects)} .NET projects and {len(rows)} module records.")
