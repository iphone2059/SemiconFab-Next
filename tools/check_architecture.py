"""Check flat independent layout, project reference DAG, purity rules and frontend boundaries."""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
NAME = re.compile(r'^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$')
PURE = {'fab_ids', 'simulation_core', 'fab_optimization_abstractions', 'fab_security_policies', 'fab_industrial_profiles'}

for legacy in ('src', 'apps', 'tests', 'frontend'):
    assert not (ROOT / legacy).exists(), f'Legacy container remains: {legacy}'
for inherited in ('Directory.Build.props', 'Directory.Packages.props'):
    assert not (ROOT / inherited).exists(), f'Shared MSBuild file breaks project independence: {inherited}'
assert not list(ROOT.glob('*.sln*')), 'Repository must not contain a master solution (sln/slnx)'

projects = {}
for csproj in sorted(ROOT.glob('*/*.csproj')):
    name = csproj.stem
    assert csproj.parent.parent == ROOT and csproj.parent.name == name, f'Project must live flat at repo root: {csproj}'
    assert NAME.match(name), f'Project name must be lower_snake_case: {name}'
    projects[name] = (csproj, ET.parse(csproj).getroot())
assert len(projects) == 65, f'Expected 65 independent projects, found {len(projects)}'

graph = {}
for name, (csproj, xml) in projects.items():
    assert xml.findall('.//TargetFramework'), f'{name} must declare TargetFramework itself'
    assert not xml.findall('.//ManagePackageVersionsCentrally') and not xml.findall('.//PackageVersion'), f'{name} must not rely on central package management'
    for package in xml.findall('.//PackageReference'):
        assert package.attrib.get('Version'), f'{name} PackageReference requires an explicit Version: {package.attrib.get("Include")}'
    refs = set()
    for ref in xml.findall('.//ProjectReference'):
        target = (csproj.parent / ref.attrib['Include']).resolve()
        found = [other for other, (p, _) in projects.items() if p.resolve() == target]
        assert found, f'Missing project reference: {name} -> {target}'
        refs.add(found[0])
    graph[name] = refs


def acyclic(edges):
    done, active = set(), set()

    def visit(node):
        assert node not in active, f'Dependency cycle at {node}'
        if node in done:
            return
        active.add(node)
        for target in edges.get(node, ()):
            visit(target)
        active.remove(node)
        done.add(node)

    for node in edges:
        visit(node)


acyclic(graph)

for name, (csproj, xml) in projects.items():
    refs = graph[name]
    pure = name.endswith('_domain') or name in PURE
    if pure:
        assert not xml.findall('.//FrameworkReference'), f'Framework leaked into pure layer: {name}'
        assert not xml.findall('.//PackageReference'), f'Package in pure layer requires review: {name}'
        for source in csproj.parent.rglob('*.cs'):
            if {'obj', 'bin'} & set(source.parts):
                continue
            text = source.read_text(encoding='utf-8-sig')
            assert not re.search(r'^using (?:Microsoft\.AspNetCore|Microsoft\.EntityFrameworkCore|Npgsql|System\.Net\.Http)', text, re.M), f'I/O import in pure layer: {source}'
    if name.endswith('_domain'):
        assert refs <= {'fab_ids', 'fab_security_policies', 'fab_industrial_profiles', 'fab_optimization_abstractions'}, f'Domain dependency: {name} -> {refs}'
    if name == 'fab_contracts':
        assert refs <= {'fab_ids'}, 'fab_contracts must not reference domain implementation'
    if name.endswith('_application'):
        owner = name.removesuffix('_application')
        for ref in refs:
            assert not ref.endswith('_infrastructure'), f'Cross-domain implementation dependency: {name} -> {ref}'
            assert not ref.endswith('_application'), f'Application-to-application dependency: {name} -> {ref}'
            assert (not ref.endswith('_domain')) or ref == owner + '_domain', f'Foreign domain dependency: {name} -> {ref}'

packages = {}
for folder in sorted(ROOT.glob('web_*')):
    manifest = folder / 'package.json'
    if not manifest.exists():
        continue
    packages[json.loads(manifest.read_text(encoding='utf-8'))['name']] = folder
assert len(packages) == 9, f'Expected web app plus 8 frontend packages, found {len(packages)}'

edges = {}
for name, folder in packages.items():
    data = json.loads((folder / 'package.json').read_text(encoding='utf-8'))
    deps = {**data.get('dependencies', {}), **data.get('devDependencies', {})}
    edges[name] = {dep for dep in deps if dep in packages}
    if folder.name in {'web_fab_scene', 'web_state_sync'}:
        assert not any(dep.startswith('@babylonjs/') for dep in deps), f'Engine implementation leaked into {name}'
    for source in (folder / 'src').rglob('*'):
        if source.suffix not in {'.ts', '.tsx'}:
            continue
        text = source.read_text(encoding='utf-8')
        assert not re.search(r'getContext\(\s*[\'\"](?:webgl2?|experimental-webgl)[\'\"]', text), f'Forbidden WebGL context: {source}'
acyclic(edges)
assert len(list((ROOT / 'docs/modules').glob('M*.md'))) == 18, 'Module record count changed'
print(f'PASS: {len(projects)} independent .NET projects / {len(packages)} frontend packages; flat layout, DAG, module records and pure-layer boundaries.')
